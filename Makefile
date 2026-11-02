# Shortcuts for the usual commands (see CLAUDE.md and README.md). Run `make` for the list.

SHELL := bash
.DEFAULT_GOAL := help

# Android: the environment script exports JAVA_HOME, ANDROID_HOME and NDK_HOME.
# Never combine it with ~/.local/piano-sysroot/env.sh.
ANDROID_ENV ?= $(HOME)/.local/android-env.sh
# One ABI at a time (cargo is memory hungry): armv7 | aarch64 | x86_64 | i686
ABI         ?= armv7
APP_ID      := dev.fmanzano.pianotracker
APK         := src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
WITH_ANDROID := source $(ANDROID_ENV) &&

.PHONY: help dev web build bundle \
	android-build android-install android-run android-logs android-devices \
	test test-watch test-rust test-ci coverage-rust check clean-android

help: ## Show this list
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)


dev: ## Full app: Angular dev server on :4200 + the Rust backend
	npm run tauri dev

web: ## Frontend only in the browser (backend calls fail gracefully)
	npm start

build: ## Build the frontend (dist/piano-tracker/browser)
	npm run build

bundle: ## Build the .deb and .AppImage packages
	npm run tauri build

check: ## Type-check the backend (cargo check)
	cd src-tauri && cargo check


android-devices: ## List the devices adb can see
	$(WITH_ANDROID) adb devices -l

android-build: ## Build the debug APK (ABI=armv7 by default)
	$(WITH_ANDROID) npx tauri android build --debug --apk --target $(ABI)

android-install: ## Install the last built APK on the connected device
	$(WITH_ANDROID) adb install -r $(APK)

android-run: android-build android-install ## Build, install and launch on the connected device
	$(WITH_ANDROID) adb shell am start -n $(APP_ID)/.MainActivity

android-logs: ## Follow the app's log on the device (Ctrl+C to stop)
	$(WITH_ANDROID) adb logcat -v time --pid=$$(adb shell pidof $(APP_ID))

clean-android: ## Remove the Android build outputs (not the generated project)
	rm -rf src-tauri/gen/android/app/build src-tauri/gen/android/build


test: test-ci test-rust ## Run the frontend and backend tests once

test-ci: ## Frontend tests once, with coverage in coverage/piano-tracker/
	npm run test:ci

test-watch: ## Frontend tests in watch mode
	npm test

test-rust: ## Backend tests (cargo test --lib)
	cd src-tauri && cargo test --lib

coverage-rust: ## Backend coverage (needs `cargo install cargo-llvm-cov`)
	cd src-tauri && cargo llvm-cov --lib --summary-only
