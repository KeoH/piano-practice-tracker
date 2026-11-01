import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 37
    namespace = "dev.fmanzano.pianotracker"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "dev.fmanzano.pianotracker"
        minSdk = 24
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

// cpal's Android backend (oboe) is C++ and links the shared runtime (`oboe-sys` feature
// `shared-stdcxx`), so the APK has to carry libc++_shared.so for each ABI it ships.
val copyCppShared by tasks.registering {
    val jniLibsDir = layout.projectDirectory.dir("src/main/jniLibs").asFile
    val abis = mapOf(
        "armeabi-v7a" to "arm-linux-androideabi",
        "arm64-v8a" to "aarch64-linux-android",
        "x86" to "i686-linux-android",
        "x86_64" to "x86_64-linux-android",
    )
    doLast {
        // NDK_HOME is exported by the Tauri CLI (and by ~/.local/android-env.sh).
        val ndk = File(System.getenv("NDK_HOME") ?: System.getenv("ANDROID_NDK_HOME") ?: error("NDK_HOME is not set"))
        val hostTag = listOf("linux-x86_64", "darwin-x86_64").first { File(ndk, "toolchains/llvm/prebuilt/$it").isDirectory }
        abis.forEach { (abi, triple) ->
            val src = File(ndk, "toolchains/llvm/prebuilt/$hostTag/sysroot/usr/lib/$triple/libc++_shared.so")
            val dest = File(jniLibsDir, "$abi/libc++_shared.so")
            dest.parentFile.mkdirs()
            src.copyTo(dest, overwrite = true)
        }
    }
}
tasks.matching { it.name == "preBuild" }.configureEach { dependsOn(copyCppShared) }

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
