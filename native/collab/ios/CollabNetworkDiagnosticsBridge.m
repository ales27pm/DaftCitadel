#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(CollabNetworkDiagnostics, RCTEventEmitter)
RCT_EXTERN_METHOD(getCurrentLinkMetrics:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(beginObserving)
RCT_EXTERN_METHOD(endObserving)
RCT_EXTERN_METHOD(setPollingInterval:(nonnull NSNumber *)intervalMs)
@end
