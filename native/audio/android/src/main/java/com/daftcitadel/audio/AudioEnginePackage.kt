package com.daftcitadel.audio

import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.uimanager.ViewManager
import com.facebook.react.TurboReactPackage

class AudioEnginePackage : TurboReactPackage() {
  /**
   * Provides the native module instance matching the requested name.
   *
   * @param name The module name requested by React Native.
   * @param reactContext The React application context used to construct the module.
   * @return An instance of AudioEngineModule when `name` equals AudioEngineModule.NAME, `null` otherwise.
   */
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
    return if (name == AudioEngineModule.NAME) {
      AudioEngineModule(reactContext)
    } else {
      null
    }
  }

  /**
   * Supply React Native module metadata for the AudioEngineModule.
   *
   * The returned provider exposes a mapping from AudioEngineModule.NAME to a ReactModuleInfo
   * that identifies the module class and its capabilities.
   *
   * @return A ReactModuleInfoProvider that maps `AudioEngineModule.NAME` to a `ReactModuleInfo`
   *         with `name = AudioEngineModule.NAME`, `className = AudioEngineModule::class.java.name`,
   *         `needsEagerInit = false`, `hasConstants = false`, `isTurboModule = true`,
   *         `isUIManagerModule = false`, and `supportsWeb = true`.
   */
  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider {
      mapOf(
        AudioEngineModule.NAME to ReactModuleInfo(
          AudioEngineModule.NAME,
          AudioEngineModule::class.java.name,
          false,
          false,
          true,
          false,
          true
        )
      )
    }
  }

  /**
   * Supplies the set of ViewManagers this package exposes to React Native.
   *
   * @return A mutable list of `ViewManager` instances available to React Native; empty when the package provides no view managers.
   */
  override fun createViewManagers(
    reactContext: ReactApplicationContext
  ): MutableList<ViewManager<*, *>> = mutableListOf()
}