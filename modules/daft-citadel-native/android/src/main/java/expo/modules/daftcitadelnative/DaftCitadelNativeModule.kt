package expo.modules.daftcitadelnative

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class DaftCitadelNativeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DaftCitadelNative")

    Constant("bridgeVersion") {
      "1.0.0"
    }

    Function("isAvailable") {
      true
    }
  }
}
