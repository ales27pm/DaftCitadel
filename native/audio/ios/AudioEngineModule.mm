#import "AudioEngineModule.h"

#import <React/RCTConvert.h>
#import <ReactCommon/RCTTurboModule.h>
#import <os/log.h>

#include <algorithm>
#include <cmath>
#include <cctype>
#include <exception>
#include <limits>
#include <string>
#include <utility>
#include <vector>
#include <cstring>

#import "audio-engine/platform/common/NodeFactory.h"
#import "audio-engine/platform/ios/AudioEngineBridge.hpp"
#import "audio_engine/SceneGraph.h"

using daft::audio::bridge::AudioEngineBridge;
using daft::audio::bridge::CreateNode;
using daft::audio::bridge::NodeOptions;

namespace {
os_log_t ModuleLogger() {
  static os_log_t logger = os_log_create("com.daft.audio", "bridge");
  return logger;
}

std::string NormalizeKey(NSString* key) {
  std::string result([key UTF8String]);
  std::transform(result.begin(), result.end(), result.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return result;
}

std::string Trim(std::string value) {
  const auto first = std::find_if_not(value.begin(), value.end(), [](unsigned char c) {
    return std::isspace(c) != 0;
  });
  const auto last = std::find_if_not(value.rbegin(), value.rend(), [](unsigned char c) {
                    return std::isspace(c) != 0;
                  }).base();
  if (first >= last) {
    return std::string();
  }
  return std::string(first, last);
}

std::string ToLowerCopy(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return value;
}

NodeOptions ConvertOptions(NSDictionary* options) {
  NodeOptions converted;
  if (options == nil) {
    return converted;
  }
  for (NSString* key in options) {
    id value = options[key];
    if (value == nil) {
      continue;
    }
    const std::string normalizedKey = NormalizeKey(key);
    if ([value isKindOfClass:[NSNumber class]]) {
      converted[normalizedKey] = [value doubleValue];
    } else if ([value isKindOfClass:[NSString class]]) {
      NSString* stringValue = (NSString*)value;
      std::string trimmed = Trim([stringValue UTF8String] ? [stringValue UTF8String] : "");
      if (trimmed.empty()) {
        continue;
      }
      const std::string lowered = ToLowerCopy(trimmed);
      if (lowered == "true" || lowered == "yes" || lowered == "on") {
        converted[normalizedKey] = 1.0;
        continue;
      }
      if (lowered == "false" || lowered == "no" || lowered == "off") {
        converted[normalizedKey] = 0.0;
        continue;
      }
      try {
        const double parsed = std::stod(trimmed);
        converted[normalizedKey] = parsed;
      } catch (const std::exception&) {
        os_log_info(ModuleLogger(), "Ignoring non-numeric option '%@' for key %{public}@", stringValue, key);
      }
    }
  }
  return converted;
}

void RejectPromise(RCTPromiseRejectBlock reject, NSString* code, const std::string& message) {
  reject(code, [NSString stringWithUTF8String:message.c_str()], nil);
}
}  // namespace

@implementation AudioEngineModule

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModuleWithJsInvoker:(std::shared_ptr<facebook::react::CallInvoker>)jsInvoker
                                                                nativeInvoker:(std::shared_ptr<facebook::react::CallInvoker>)nativeInvoker
                                                                   perfLogger:(id<RCTTurboModulePerformanceLogger>)perfLogger {
  return std::make_shared<facebook::react::ObjCTurboModule>(self, jsInvoker, nativeInvoker, perfLogger);
}

RCT_EXPORT_METHOD(initialize:(double)sampleRate
                  framesPerBuffer:(nonnull NSNumber*)framesPerBuffer
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  if (!std::isfinite(sampleRate) || sampleRate <= 0.0 || framesPerBuffer == nil) {
    RejectPromise(reject, @"invalid_arguments", "Invalid sample rate or buffer size supplied to initialize");
    return;
  }
  const auto framesUnsigned = framesPerBuffer.unsignedIntValue;
  const double framesValue = framesPerBuffer.doubleValue;
  if (framesUnsigned == 0U || !std::isfinite(framesValue)) {
    RejectPromise(reject, @"invalid_arguments", "Invalid sample rate or buffer size supplied to initialize");
    return;
  }
  const double diff = std::fabs(framesValue - static_cast<double>(framesUnsigned));
  if (diff > std::numeric_limits<double>::epsilon()) {
    RejectPromise(reject, @"invalid_arguments", "framesPerBuffer must be an integer value");
    return;
  }
  const auto maxFrames = daft::audio::SceneGraph::maxSupportedFramesPerBuffer();
  if (framesUnsigned > maxFrames) {
    std::string message = "framesPerBuffer exceeds engine capacity (max " + std::to_string(maxFrames) + ")";
    RejectPromise(reject, @"invalid_arguments", message);
    return;
  }
  try {
    AudioEngineBridge::initialize(sampleRate, framesUnsigned);
    resolve(nil);
  } catch (const std::exception& ex) {
    os_log_error(ModuleLogger(), "Initialize failed: %{public}s", ex.what());
    RejectPromise(reject, @"initialize_failed", ex.what());
  }
}

RCT_EXPORT_METHOD(shutdown:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  try {
    AudioEngineBridge::shutdown();
    resolve(nil);
  } catch (const std::exception& ex) {
    os_log_error(ModuleLogger(), "Shutdown failed: %{public}s", ex.what());
    RejectPromise(reject, @"shutdown_failed", ex.what());
  }
}

RCT_EXPORT_METHOD(addNode:(NSString*)nodeId
                  nodeType:(NSString*)nodeType
                  options:(NSDictionary*)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  if (nodeId.length == 0 || nodeType.length == 0) {
    RejectPromise(reject, @"invalid_arguments", "nodeId and nodeType are required");
    return;
  }
  NodeOptions nativeOptions = ConvertOptions(options);
  std::string error;
  auto node = CreateNode([nodeType UTF8String], nativeOptions, error);
  if (!node) {
    os_log_error(ModuleLogger(), "Unsupported node type %{public}@", nodeType);
    RejectPromise(reject, @"unsupported_node", error);
    return;
  }
  const bool success = AudioEngineBridge::addNode([nodeId UTF8String], std::move(node));
  if (!success) {
    std::string message = "Failed to add node '" + std::string([nodeId UTF8String]) + "'";
    os_log_error(ModuleLogger(), "%{public}s", message.c_str());
    RejectPromise(reject, @"add_node_failed", message);
    return;
  }
  resolve(nil);
}

RCT_EXPORT_METHOD(registerClipBuffer:(NSString*)bufferKey
                  sampleRate:(double)sampleRate
                  channels:(nonnull NSNumber*)channels
                  frames:(nonnull NSNumber*)frames
                  channelData:(NSArray*)channelData
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  const std::string key = Trim(bufferKey.length > 0 ? [bufferKey UTF8String] : "");
  if (key.empty()) {
    RejectPromise(reject, @"invalid_arguments", "bufferKey is required");
    return;
  }
  if (!std::isfinite(sampleRate) || sampleRate <= 0.0) {
    RejectPromise(reject, @"invalid_arguments", "sampleRate must be positive and finite");
    return;
  }
  if (channels == nil || frames == nil) {
    RejectPromise(reject, @"invalid_arguments", "channels and frames are required");
    return;
  }

  const auto channelCountUnsigned = channels.unsignedIntegerValue;
  const auto framesUnsigned = frames.unsignedLongLongValue;
  const double channelsValue = channels.doubleValue;
  const double framesValue = frames.doubleValue;
  if (channelCountUnsigned == 0 || framesUnsigned == 0) {
    RejectPromise(reject, @"invalid_arguments", "channels and frames must be positive integers");
    return;
  }
  if (!std::isfinite(channelsValue) || !std::isfinite(framesValue)) {
    RejectPromise(reject, @"invalid_arguments", "channels and frames must be finite");
    return;
  }
  if (std::fabs(channelsValue - static_cast<double>(channelCountUnsigned)) > std::numeric_limits<double>::epsilon() ||
      std::fabs(framesValue - static_cast<double>(framesUnsigned)) > std::numeric_limits<double>::epsilon()) {
    RejectPromise(reject, @"invalid_arguments", "channels and frames must be integer values");
    return;
  }
  if (channelData == nil || channelData.count != channelCountUnsigned) {
    RejectPromise(reject, @"invalid_arguments", "channelData length must equal channels");
    return;
  }

  constexpr std::size_t kMaxChannels = 64;
  constexpr unsigned long long kMaxFrames = 10'000'000ULL;

  if (channelCountUnsigned > kMaxChannels) {
    RejectPromise(reject, @"invalid_arguments", "channels must be between 1 and 64");
    return;
  }
  if (framesUnsigned > kMaxFrames) {
    RejectPromise(reject, @"invalid_arguments", "frames must be between 1 and 10000000");
    return;
  }
  if (framesUnsigned > std::numeric_limits<std::size_t>::max()) {
    RejectPromise(reject, @"invalid_arguments", "frames exceed platform limits");
    return;
  }

  const std::size_t channelCount = static_cast<std::size_t>(channelCountUnsigned);
  const std::size_t frameCount = static_cast<std::size_t>(framesUnsigned);
  if (frameCount > std::numeric_limits<std::size_t>::max() / sizeof(float)) {
    RejectPromise(reject, @"invalid_arguments", "frames exceed platform limits");
    return;
  }
  const std::size_t requiredBytes = frameCount * sizeof(float);

  std::vector<std::vector<float>> nativeChannels;
  nativeChannels.reserve(channelCount);

  for (NSUInteger index = 0; index < channelCountUnsigned; ++index) {
    id entry = channelData[index];
    if (![entry isKindOfClass:[NSData class]]) {
      RejectPromise(reject, @"invalid_arguments", "channelData entries must be ArrayBuffer instances");
      return;
    }
    NSData* data = (NSData*)entry;
    if (data.length < requiredBytes) {
      RejectPromise(reject, @"invalid_arguments", "channelData entry is smaller than the expected frame count");
      return;
    }
    std::vector<float> channel(frameCount);
    std::memcpy(channel.data(), data.bytes, requiredBytes);
    nativeChannels.push_back(std::move(channel));
  }

  const bool ok = AudioEngineBridge::registerClipBuffer(key, sampleRate, channelCount, frameCount, std::move(nativeChannels));
  if (!ok) {
    os_log_error(ModuleLogger(), "Failed to register clip buffer %{public}@", bufferKey);
    RejectPromise(reject, @"register_clip_failed", "Failed to register clip buffer");
    return;
  }
  resolve(nil);
}

RCT_EXPORT_METHOD(removeNode:(NSString*)nodeId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  if (nodeId.length == 0) {
    RejectPromise(reject, @"invalid_arguments", "nodeId is required");
    return;
  }
  try {
    AudioEngineBridge::removeNode([nodeId UTF8String]);
    resolve(nil);
  } catch (const std::exception& ex) {
    os_log_error(ModuleLogger(), "removeNode failed: %{public}s", ex.what());
    RejectPromise(reject, @"remove_node_failed", ex.what());
  }
}

RCT_EXPORT_METHOD(connectNodes:(NSString*)source
                  destination:(NSString*)destination
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  if (source.length == 0 || destination.length == 0) {
    RejectPromise(reject, @"invalid_arguments", "source and destination are required");
    return;
  }
  const bool ok = AudioEngineBridge::connect([source UTF8String], [destination UTF8String]);
  if (!ok) {
    std::string message = "Failed to connect '" + std::string([source UTF8String]) + "' -> '" +
                          std::string([destination UTF8String]) + "'";
    os_log_error(ModuleLogger(), "%{public}s", message.c_str());
    RejectPromise(reject, @"connect_failed", message);
    return;
  }
  resolve(nil);
}

RCT_EXPORT_METHOD(disconnectNodes:(NSString*)source
                  destination:(NSString*)destination
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  if (source.length == 0 || destination.length == 0) {
    RejectPromise(reject, @"invalid_arguments", "source and destination are required");
    return;
  }
  try {
    AudioEngineBridge::disconnect([source UTF8String], [destination UTF8String]);
    resolve(nil);
  } catch (const std::exception& ex) {
    os_log_error(ModuleLogger(), "disconnectNodes failed: %{public}s", ex.what());
    RejectPromise(reject, @"disconnect_failed", ex.what());
  }
}

RCT_EXPORT_METHOD(scheduleParameterAutomation:(NSString*)nodeId
                  parameter:(NSString*)parameter
                  frame:(nonnull NSNumber*)frame
                  value:(double)value
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  if (nodeId.length == 0 || parameter.length == 0 || frame == nil) {
    RejectPromise(reject, @"invalid_arguments", "nodeId, parameter, and frame are required");
    return;
  }
  const double frameValue = frame.doubleValue;
  if (!std::isfinite(frameValue) || frameValue < 0.0) {
    RejectPromise(reject, @"invalid_arguments", "frame must be a non-negative integer");
    return;
  }
  if (!std::isfinite(value)) {
    RejectPromise(reject, @"invalid_arguments", "value must be finite");
    return;
  }
  const unsigned long long frameTicks = frame.unsignedLongLongValue;
  const double diff = std::fabs(frameValue - static_cast<double>(frameTicks));
  if (diff > 1e-6) {
    RejectPromise(reject, @"invalid_arguments", "frame must be a non-negative integer");
    return;
  }
  try {
    AudioEngineBridge::scheduleParameterAutomation([nodeId UTF8String], [parameter UTF8String], frameTicks, value);
    resolve(nil);
  } catch (const std::exception& ex) {
    os_log_error(ModuleLogger(), "scheduleParameterAutomation failed: %{public}s", ex.what());
    RejectPromise(reject, @"automation_failed", ex.what());
  }
}

RCT_EXPORT_METHOD(getRenderDiagnostics:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  try {
    const auto diagnostics = AudioEngineBridge::getDiagnostics();
    resolve(@{
      @"xruns" : @(static_cast<NSInteger>(diagnostics.xruns)),
      @"lastRenderDurationMicros" : @(diagnostics.lastRenderDurationMicros),
    });
  } catch (const std::exception& ex) {
    os_log_error(ModuleLogger(), "getRenderDiagnostics failed: %{public}s", ex.what());
    RejectPromise(reject, @"diagnostics_failed", ex.what());
  }
}

@end
