#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(AudioSampleLoaderModule, NSObject)
RCT_EXTERN_METHOD(decode:(NSString *)filePath
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
@end
