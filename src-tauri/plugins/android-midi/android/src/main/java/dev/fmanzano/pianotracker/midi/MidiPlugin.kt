package dev.fmanzano.pianotracker.midi

import android.app.Activity
import android.content.Context
import android.media.midi.MidiDevice
import android.media.midi.MidiDeviceInfo
import android.media.midi.MidiManager
import android.media.midi.MidiOutputPort
import android.media.midi.MidiReceiver
import android.os.Handler
import android.os.Looper
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class OpenPortArgs {
  lateinit var id: String
  lateinit var onMessage: Channel
}

/**
 * Input side of the system MIDI service. Ports are the *output* ports of the devices (what a
 * keyboard sends us), identified as `<deviceId>:<portNumber>`.
 */
@TauriPlugin
class MidiPlugin(private val activity: Activity) : Plugin(activity) {
  private val manager = activity.getSystemService(Context.MIDI_SERVICE) as MidiManager
  private val main = Handler(Looper.getMainLooper())

  private var device: MidiDevice? = null
  private var port: MidiOutputPort? = null

  @Command
  fun listPorts(invoke: Invoke) {
    val ports = JSArray()
    @Suppress("DEPRECATION")
    for (info in manager.devices) {
      val deviceName = info.properties.getString(MidiDeviceInfo.PROPERTY_NAME)
        ?: info.properties.getString(MidiDeviceInfo.PROPERTY_PRODUCT)
        ?: "MIDI ${info.id}"
      for (p in info.ports) {
        if (p.type != MidiDeviceInfo.PortInfo.TYPE_OUTPUT) continue
        val entry = JSObject()
        entry.put("id", "${info.id}:${p.portNumber}")
        entry.put("name", if (p.name.isNullOrEmpty()) deviceName else "$deviceName ${p.name}")
        ports.put(entry)
      }
    }
    val result = JSObject()
    result.put("ports", ports)
    invoke.resolve(result)
  }

  @Command
  fun openPort(invoke: Invoke) {
    val args = invoke.parseArgs(OpenPortArgs::class.java)
    val (deviceId, portNumber) = args.id.split(":").let {
      (it.getOrNull(0)?.toIntOrNull() to it.getOrNull(1)?.toIntOrNull())
    }
    if (deviceId == null || portNumber == null) {
      invoke.reject("Invalid MIDI port id: ${args.id}")
      return
    }
    @Suppress("DEPRECATION")
    val info = manager.devices.firstOrNull { it.id == deviceId }
    if (info == null) {
      invoke.reject("MIDI device not found: ${args.id}")
      return
    }
    closeCurrent()
    manager.openDevice(info, { opened ->
      if (opened == null) {
        invoke.reject("Could not open the MIDI device")
        return@openDevice
      }
      val output = opened.openOutputPort(portNumber)
      if (output == null) {
        opened.close()
        invoke.reject("Could not open the MIDI port (busy?)")
        return@openDevice
      }
      output.connect(object : MidiReceiver() {
        override fun onSend(msg: ByteArray, offset: Int, count: Int, timestamp: Long) {
          val data = JSArray()
          for (i in offset until offset + count) data.put(msg[i].toInt() and 0xFF)
          val chunk = JSObject()
          chunk.put("data", data)
          args.onMessage.send(chunk)
        }
      })
      synchronized(this) {
        device = opened
        port = output
      }
      invoke.resolve()
    }, main)
  }

  @Command
  fun closePort(invoke: Invoke) {
    closeCurrent()
    invoke.resolve()
  }

  private fun closeCurrent() {
    synchronized(this) {
      try {
        port?.close()
        device?.close()
      } catch (_: Exception) {
        // The device may already be gone (unplugged).
      }
      port = null
      device = null
    }
  }
}
