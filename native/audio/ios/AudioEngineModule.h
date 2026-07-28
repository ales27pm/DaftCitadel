#import <React/RCTBridgeModule.h>
#import <React/RCTInvalidating.h>

// Keep this module on React Native's legacy-module interop path until it has a
// generated TurboModule spec. Generic RCTTurboModule conformance produces an
// empty JS method table in bridgeless builds.
@interface AudioEngineModule : NSObject <RCTBridgeModule, RCTInvalidating>
@end
