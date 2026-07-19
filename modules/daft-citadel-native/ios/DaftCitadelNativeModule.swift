import ExpoModulesCore

public final class DaftCitadelNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DaftCitadelNative")

    Constant("bridgeVersion") {
      "1.0.0"
    }

    Function("isAvailable") {
      true
    }
  }
}
