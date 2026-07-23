#import "AudioEngineModule.h"
#import "AudioDeviceDriver.h"

#import <React/RCTConvert.h>
#import <os/log.h>

#include <algorithm>
#include <cmath>
#include <cctype>
#include <exception>
#include <limits>
#include <stdexcept>
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
  if (![key isKindOfClass:[NSString class]]) {
    throw std::invalid_argument("Audio node option keys must be strings");
  }
  const char* utf8 = [key UTF8String];
  if (utf8 == nullptr) {
    throw std::invalid_argument("Audio node option key is not valid UTF-8");
  }
  std::string result(utf8);
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
  if (![options isKindOfClass:[NSDictionary class]]) {
    throw std::invalid_argument("Audio node options must be an object");
  }
  for (id rawKey in options) {
    if (![rawKey isKindOfClass:[NSString class]]) {
      throw std::invalid_argument("Audio node option keys must be strings");
    }
    NSString* key = (NSString*)rawKey;
    id value = options[key];
    if (value == nil || value == [NSNull null]) {
      continue;
    }
    const std::string normalizedKey = NormalizeKey(key);
    if ([value isKindOfClass:[NSNumber class]]) {
      converted.setNumeric(normalizedKey, [value doubleValue]);
    } else if ([value isKindOfClass:[NSString class]]) {
      NSString* stringValue = (NSString*)value;
      const char* utf8 = [stringValue UTF8String];
      if (utf8 == nullptr) {
        throw std::invalid_argument("Audio node option value is not valid UTF-8");
      }
      std::string trimmed = Trim(utf8);
      if (trimmed.empty()) {
        continue;
      }
      converted.setString(normalizedKey, trimmed);
      const std::string lowered = ToLowerCopy(trimmed);
      if (lowered == "true" || lowered == "yes" || lowered == "on") {
        converted.setNumeric(normalizedKey, 1.0);
      } else if (lowered == "false" || lowered == "no" || lowered == "off") {
        converted.setNumeric(normalizedKey, 0.0);
      } else {
        try {
          const double parsed = std::stod(trimmed);
          converted.setNumeric(normalizedKey, parsed);
        } catch (const std::exception&) {
          // keep as string only
        }
      }
    } else {
      throw std::invalid_argument("Audio node option values must be strings, numbers, or booleans");
    }
  }
  return converted;
}

std::string ToStdString(NSString* value, const char* fieldName) {
  if (![value isKindOfClass:[NSString class]]) {
    throw std::invalid_argument(std::string(fieldName) + " must be a string");
  }
  const char* utf8 = [value UTF8String];
  if (utf8 == nullptr) {
    throw std::invalid_argument(std::string(fieldName) + " is not valid UTF-8");
  }
  return std::string(utf8);
}

NSString* NSStringFromStdString(const std::string& value) {
  NSString* converted = [NSString stringWithUTF8String:value.c_str()];
  return converted ?: @"Native audio operation failed";
}

void RejectPromise(RCTPromiseRejectBlock reject, NSString* code, const std::string& message) {
  reject(code, NSStringFromStdString(message), nil);
}

void RejectObjectiveCException(RCTPromiseRejectBlock reject, NSString* code,
                               NSString* operation, NSException* exception) {
  NSString* reason = exception.reason ?: @"No exception reason supplied";
  NSString* exceptionName = exception.name ?: @"NSException";
  NSString* message = [NSString stringWithFormat:@"%@ failed: %@", operation, reason];
  NSError* error = [NSError errorWithDomain:@"dev.daftcitadel.audio-bridge"
                                       code:1
                                   userInfo:@{
                                     NSLocalizedDescriptionKey : message,
                                     @"operation" : operation,
                                     @"exceptionName" : exceptionName,
                                     @"exceptionReason" : reason,
                                   }];
  os_log_error(ModuleLogger(), "%{public}@ raised %{public}@: %{public}@",
               operation, exceptionName, reason);
  reject(code, message, error);
}

void LogObjectiveCException(NSString* operation, NSException* exception) {
  os_log_error(ModuleLogger(), "%{public}@ raised %{public}@: %{public}@",
               operation, exception.name,
               exception.reason ?: @"No exception reason supplied");
}

void PerformPromiseOperation(RCTPromiseRejectBlock reject, NSString* code,
                             NSString* operation, RCTPromiseResolveBlock resolve,
                             void (^body)(RCTPromiseResolveBlock, RCTPromiseRejectBlock)) {
  enum class OutcomeState { pending, resolved, rejected };
  __block OutcomeState state = OutcomeState::pending;
  __block id resolvedValue = nil;
  __block NSString* rejectedCode = nil;
  __block NSString* rejectedMessage = nil;
  __block NSError* rejectedError = nil;

  RCTPromiseResolveBlock captureResolve = ^(id value) {
    if (state != OutcomeState::pending) {
      os_log_error(ModuleLogger(), "%{public}@ attempted to settle more than once", operation);
      return;
    }
    state = OutcomeState::resolved;
    resolvedValue = value;
  };
  RCTPromiseRejectBlock captureReject = ^(NSString* failureCode, NSString* message,
                                           NSError* error) {
    if (state != OutcomeState::pending) {
      os_log_error(ModuleLogger(), "%{public}@ attempted to settle more than once", operation);
      return;
    }
    state = OutcomeState::rejected;
    rejectedCode = failureCode ?: code;
    rejectedMessage = message ?: [NSString stringWithFormat:@"%@ failed", operation];
    rejectedError = error;
  };

  try {
    @try {
      body(captureResolve, captureReject);
    } @catch (NSException* exception) {
      RejectObjectiveCException(captureReject, code, operation, exception);
    }
  } catch (const std::exception& ex) {
    os_log_error(ModuleLogger(), "%{public}@ failed: %{public}s", operation, ex.what());
    RejectPromise(captureReject, code, ex.what());
  } catch (...) {
    NSString* message = [NSString stringWithFormat:@"%@ failed", operation];
    os_log_error(ModuleLogger(), "%{public}@ failed with an unknown C++ exception", operation);
    captureReject(code, message, nil);
  }

  if (state == OutcomeState::pending) {
    captureReject(@"internal_error",
                  [NSString stringWithFormat:@"%@ completed without a result", operation], nil);
  }

  @try {
    if (state == OutcomeState::resolved) {
      resolve(resolvedValue);
    } else {
      reject(rejectedCode, rejectedMessage, rejectedError);
    }
  } @catch (NSException* exception) {
    LogObjectiveCException([operation stringByAppendingString:@" promise settlement"], exception);
  }
}

void ShutdownBridgeIfOwner(NSString* operation,
                           AudioEngineBridge::EngineGeneration generation) {
  if (generation == 0) {
    return;
  }
  if (!AudioEngineBridge::shutdownIfOwner(generation)) {
    os_log_info(ModuleLogger(), "%{public}@ did not own generation %llu", operation,
                static_cast<unsigned long long>(generation));
  }
}
}  // namespace

@interface AudioEngineModule ()
@property(nonatomic, strong) DaftAudioDeviceDriver* deviceDriver;
@property(nonatomic, assign) double configuredSampleRate;
@property(nonatomic, assign) NSUInteger configuredFramesPerBuffer;
@property(nonatomic, assign) BOOL engineConfigured;
@property(nonatomic, assign) BOOL deviceStarted;
@property(nonatomic, assign) AudioEngineBridge::EngineGeneration engineGeneration;
@end

@implementation AudioEngineModule

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (dispatch_queue_t)methodQueue {
  static dispatch_queue_t audioControlQueue;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    audioControlQueue =
        dispatch_queue_create("dev.daftcitadel.audio-control", DISPATCH_QUEUE_SERIAL);
  });
  return audioControlQueue;
}

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _deviceDriver = [[DaftAudioDeviceDriver alloc] init];
    _configuredSampleRate = 0.0;
    _configuredFramesPerBuffer = 0;
    _engineConfigured = NO;
    _deviceStarted = NO;
    _engineGeneration = 0;
  }
  return self;
}

- (void)clearConfigurationState {
  self.engineConfigured = NO;
  self.configuredSampleRate = 0.0;
  self.configuredFramesPerBuffer = 0;
  self.engineGeneration = 0;
}

- (void)stopDeviceSafelyForOperation:(NSString*)operation {
  @try {
    [self.deviceDriver stop];
  } @catch (NSException* exception) {
    LogObjectiveCException(operation, exception);
  }
  self.deviceStarted = NO;
}

RCT_EXPORT_METHOD(initialize:(double)sampleRate
                  framesPerBuffer:(nonnull NSNumber*)framesPerBuffer
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"initialize_failed", @"Audio engine initialization", resolve,
                          ^(RCTPromiseResolveBlock finish, RCTPromiseRejectBlock fail) {
    try {
      @try {
        if (!std::isfinite(sampleRate) || sampleRate <= 0.0 || framesPerBuffer == nil) {
          RejectPromise(fail, @"invalid_arguments",
                        "Invalid sample rate or buffer size supplied to initialize");
          return;
        }
        const auto framesUnsigned = framesPerBuffer.unsignedIntValue;
        const double framesValue = framesPerBuffer.doubleValue;
        if (framesUnsigned == 0U || !std::isfinite(framesValue)) {
          RejectPromise(fail, @"invalid_arguments",
                        "Invalid sample rate or buffer size supplied to initialize");
          return;
        }
        const double diff = std::fabs(framesValue - static_cast<double>(framesUnsigned));
        if (diff > std::numeric_limits<double>::epsilon()) {
          RejectPromise(fail, @"invalid_arguments", "framesPerBuffer must be an integer value");
          return;
        }
        const auto maxFrames = daft::audio::SceneGraph::maxSupportedFramesPerBuffer();
        if (framesUnsigned > maxFrames) {
          std::string message =
              "framesPerBuffer exceeds engine capacity (max " + std::to_string(maxFrames) + ")";
          RejectPromise(fail, @"invalid_arguments", message);
          return;
        }
        if (self.deviceStarted) {
          [self stopDeviceSafelyForOperation:@"Audio device reset before initialization"];
        }
        const auto generation = AudioEngineBridge::initialize(sampleRate, framesUnsigned);
        self.configuredSampleRate = sampleRate;
        self.configuredFramesPerBuffer = framesUnsigned;
        self.engineGeneration = generation;
        self.engineConfigured = YES;
        finish(nil);
      } @catch (NSException* exception) {
        const auto generation = self.engineGeneration;
        [self stopDeviceSafelyForOperation:@"Audio device cleanup after initialization failure"];
        [self clearConfigurationState];
        ShutdownBridgeIfOwner(@"Audio engine initialization", generation);
        RejectObjectiveCException(fail, @"initialize_failed", @"Audio engine initialization",
                                  exception);
      }
    } catch (const std::exception& ex) {
      const auto generation = self.engineGeneration;
      [self stopDeviceSafelyForOperation:@"Audio device cleanup after initialization failure"];
      [self clearConfigurationState];
      ShutdownBridgeIfOwner(@"Audio engine initialization", generation);
      os_log_error(ModuleLogger(), "Initialize failed: %{public}s", ex.what());
      RejectPromise(fail, @"initialize_failed", ex.what());
    } catch (...) {
      const auto generation = self.engineGeneration;
      [self stopDeviceSafelyForOperation:@"Audio device cleanup after initialization failure"];
      [self clearConfigurationState];
      ShutdownBridgeIfOwner(@"Audio engine initialization", generation);
      os_log_error(ModuleLogger(), "Initialize failed with an unknown C++ exception");
      fail(@"initialize_failed", @"Audio engine initialization failed", nil);
    }
  });
}

RCT_EXPORT_METHOD(shutdown:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"shutdown_failed", @"Audio engine shutdown", resolve,
                          ^(RCTPromiseResolveBlock finish, RCTPromiseRejectBlock fail) {
    try {
      @try {
        if (self.deviceStarted) {
          [self stopDeviceSafelyForOperation:@"Audio device shutdown"];
        }
        const auto generation = self.engineGeneration;
        [self clearConfigurationState];
        ShutdownBridgeIfOwner(@"Audio engine shutdown", generation);
        finish(nil);
      } @catch (NSException* exception) {
        const auto generation = self.engineGeneration;
        [self stopDeviceSafelyForOperation:@"Audio device cleanup after shutdown failure"];
        [self clearConfigurationState];
        ShutdownBridgeIfOwner(@"Audio engine shutdown", generation);
        RejectObjectiveCException(fail, @"shutdown_failed", @"Audio engine shutdown",
                                  exception);
      }
    } catch (const std::exception& ex) {
      const auto generation = self.engineGeneration;
      [self stopDeviceSafelyForOperation:@"Audio device cleanup after shutdown failure"];
      [self clearConfigurationState];
      ShutdownBridgeIfOwner(@"Audio engine shutdown", generation);
      os_log_error(ModuleLogger(), "Shutdown failed: %{public}s", ex.what());
      RejectPromise(fail, @"shutdown_failed", ex.what());
    } catch (...) {
      const auto generation = self.engineGeneration;
      [self stopDeviceSafelyForOperation:@"Audio device cleanup after shutdown failure"];
      [self clearConfigurationState];
      ShutdownBridgeIfOwner(@"Audio engine shutdown", generation);
      os_log_error(ModuleLogger(), "Shutdown failed with an unknown C++ exception");
      fail(@"shutdown_failed", @"Audio engine shutdown failed", nil);
    }
  });
}

- (void)invalidate {
  const auto generation = self.engineGeneration;
  [self stopDeviceSafelyForOperation:@"Audio engine invalidation"];
  [self clearConfigurationState];
  ShutdownBridgeIfOwner(@"Audio engine invalidation", generation);
}

- (void)dealloc {
  const auto generation = self.engineGeneration;
  [self stopDeviceSafelyForOperation:@"Audio engine deallocation"];
  ShutdownBridgeIfOwner(@"Audio engine deallocation", generation);
}

RCT_EXPORT_METHOD(addNode:(NSString*)nodeId
                  nodeType:(NSString*)nodeType
                  options:(NSDictionary*)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"add_node_failed", @"Add audio node", resolve,
                          ^(RCTPromiseResolveBlock finish, RCTPromiseRejectBlock fail) {
    if (nodeId.length == 0 || nodeType.length == 0) {
      RejectPromise(fail, @"invalid_arguments", "nodeId and nodeType are required");
      return;
    }
    const std::string nativeNodeId = Trim(ToStdString(nodeId, "nodeId"));
    const std::string nativeNodeType = Trim(ToStdString(nodeType, "nodeType"));
    if (nativeNodeId.empty() || nativeNodeType.empty()) {
      RejectPromise(fail, @"invalid_arguments", "nodeId and nodeType are required");
      return;
    }
    const auto generation = self.engineGeneration;
    if (!self.engineConfigured || !AudioEngineBridge::isInitialized(generation)) {
      os_log_error(ModuleLogger(),
                   "Cannot add node %{public}@ (%{public}@): engine generation %llu is unavailable",
                   nodeId, nodeType, static_cast<unsigned long long>(generation));
      RejectPromise(fail, @"engine_unavailable", "Audio engine is not initialized");
      return;
    }
    NodeOptions nativeOptions = ConvertOptions(options);
    std::string error;
    auto node = CreateNode(nativeNodeType, nativeOptions, error, generation);
    if (!node) {
      os_log_error(ModuleLogger(), "Unsupported node type %{public}@", nodeType);
      RejectPromise(fail, @"unsupported_node", error);
      return;
    }
    const bool success = AudioEngineBridge::addNode(generation, nativeNodeId, std::move(node));
    if (!success) {
      std::string message = "Failed to add node '" + nativeNodeId + "'";
      os_log_error(ModuleLogger(), "%{public}s", message.c_str());
      RejectPromise(fail, @"add_node_failed", message);
      return;
    }
    os_log_info(ModuleLogger(), "Added node %{public}@ (%{public}@) to generation %llu", nodeId,
                nodeType, static_cast<unsigned long long>(generation));
    finish(nil);
  });
}

RCT_EXPORT_METHOD(registerClipBuffer:(NSString*)bufferKey
                  sampleRate:(double)sampleRate
                  channels:(nonnull NSNumber*)channels
                  frames:(nonnull NSNumber*)frames
                  channelData:(NSArray*)channelData
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"register_clip_failed", @"Register clip buffer", resolve,
                          ^(RCTPromiseResolveBlock finish, RCTPromiseRejectBlock fail) {
    const std::string key = Trim(bufferKey.length > 0 ? [bufferKey UTF8String] : "");
    if (key.empty()) {
      RejectPromise(fail, @"invalid_arguments", "bufferKey is required");
      return;
    }
    if (!std::isfinite(sampleRate) || sampleRate <= 0.0) {
      RejectPromise(fail, @"invalid_arguments", "sampleRate must be positive and finite");
      return;
    }
    if (channels == nil || frames == nil) {
      RejectPromise(fail, @"invalid_arguments", "channels and frames are required");
      return;
    }

    const auto channelCountUnsigned = channels.unsignedIntegerValue;
    const auto framesUnsigned = frames.unsignedLongLongValue;
    const double channelsValue = channels.doubleValue;
    const double framesValue = frames.doubleValue;
    if (channelCountUnsigned == 0 || framesUnsigned == 0) {
      RejectPromise(fail, @"invalid_arguments", "channels and frames must be positive integers");
      return;
    }
    if (!std::isfinite(channelsValue) || !std::isfinite(framesValue)) {
      RejectPromise(fail, @"invalid_arguments", "channels and frames must be finite");
      return;
    }
    if (std::fabs(channelsValue - static_cast<double>(channelCountUnsigned)) >
            std::numeric_limits<double>::epsilon() ||
        std::fabs(framesValue - static_cast<double>(framesUnsigned)) >
            std::numeric_limits<double>::epsilon()) {
      RejectPromise(fail, @"invalid_arguments", "channels and frames must be integer values");
      return;
    }
    if (channelData == nil || channelData.count != channelCountUnsigned) {
      RejectPromise(fail, @"invalid_arguments", "channelData length must equal channels");
      return;
    }

    constexpr std::size_t kMaxChannels = 64;
    constexpr unsigned long long kMaxFrames = 10'000'000ULL;

    if (channelCountUnsigned > kMaxChannels) {
      RejectPromise(fail, @"invalid_arguments", "channels must be between 1 and 64");
      return;
    }
    if (framesUnsigned > kMaxFrames) {
      RejectPromise(fail, @"invalid_arguments", "frames must be between 1 and 10000000");
      return;
    }
    if (framesUnsigned > std::numeric_limits<std::size_t>::max()) {
      RejectPromise(fail, @"invalid_arguments", "frames exceed platform limits");
      return;
    }

    const std::size_t channelCount = static_cast<std::size_t>(channelCountUnsigned);
    const std::size_t frameCount = static_cast<std::size_t>(framesUnsigned);
    if (frameCount > std::numeric_limits<std::size_t>::max() / sizeof(float)) {
      RejectPromise(fail, @"invalid_arguments", "frames exceed platform limits");
      return;
    }
    const std::size_t requiredBytes = frameCount * sizeof(float);

    std::vector<std::vector<float>> nativeChannels;
    nativeChannels.reserve(channelCount);

    for (NSUInteger index = 0; index < channelCountUnsigned; ++index) {
      id entry = channelData[index];
      NSData* data = nil;
      if ([entry isKindOfClass:[NSData class]]) {
        data = (NSData*)entry;
      } else if ([entry isKindOfClass:[NSString class]]) {
        data = [[NSData alloc] initWithBase64EncodedString:(NSString*)entry
                                                  options:NSDataBase64DecodingIgnoreUnknownCharacters];
      }
      if (data == nil) {
        RejectPromise(fail, @"invalid_arguments", "channelData entries must be base64 Float32 PCM strings");
        return;
      }
      if (data.length < requiredBytes) {
        RejectPromise(fail, @"invalid_arguments", "channelData entry is smaller than the expected frame count");
        return;
      }
      std::vector<float> channel(frameCount);
      std::memcpy(channel.data(), data.bytes, requiredBytes);
      nativeChannels.push_back(std::move(channel));
    }

    const auto generation = self.engineGeneration;
    const bool ok = AudioEngineBridge::registerClipBuffer(
        generation, key, sampleRate, channelCount, frameCount, std::move(nativeChannels));
    if (!ok) {
      os_log_error(ModuleLogger(), "Failed to register clip buffer %{public}@", bufferKey);
      RejectPromise(fail, @"register_clip_failed", "Failed to register clip buffer");
      return;
    }
    finish(nil);
  });
}

RCT_EXPORT_METHOD(unregisterClipBuffer:(NSString*)bufferKey
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"unregister_clip_failed", @"Unregister clip buffer", resolve,
                          ^(RCTPromiseResolveBlock finish, RCTPromiseRejectBlock fail) {
    NSString* trimmedKey =
        [bufferKey stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (trimmedKey.length == 0) {
      RejectPromise(fail, @"invalid_arguments", "bufferKey is required");
      return;
    }
    const auto generation = self.engineGeneration;
    const bool ok = AudioEngineBridge::unregisterClipBuffer(
        generation, ToStdString(trimmedKey, "bufferKey"));
    if (!ok) {
      os_log_error(ModuleLogger(), "Failed to unregister clip buffer %{public}@", trimmedKey);
      RejectPromise(fail, @"unregister_clip_failed", "Failed to unregister clip buffer");
      return;
    }
    finish(nil);
  });
}

RCT_EXPORT_METHOD(removeNode:(NSString*)nodeId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"remove_node_failed", @"Remove audio node", resolve,
                          ^(RCTPromiseResolveBlock finish, RCTPromiseRejectBlock fail) {
    if (nodeId.length == 0) {
      RejectPromise(fail, @"invalid_arguments", "nodeId is required");
      return;
    }
    const auto generation = self.engineGeneration;
    AudioEngineBridge::removeNode(generation, ToStdString(nodeId, "nodeId"));
    finish(nil);
  });
}

RCT_EXPORT_METHOD(connectNodes:(NSString*)source
                  destination:(NSString*)destination
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"connect_failed", @"Connect audio nodes", resolve,
                          ^(RCTPromiseResolveBlock finish, RCTPromiseRejectBlock fail) {
    if (source.length == 0 || destination.length == 0) {
      RejectPromise(fail, @"invalid_arguments", "source and destination are required");
      return;
    }
    const auto generation = self.engineGeneration;
    const std::string nativeSource = ToStdString(source, "source");
    const std::string nativeDestination = ToStdString(destination, "destination");
    const bool ok = AudioEngineBridge::connect(generation, nativeSource, nativeDestination);
    if (!ok) {
      std::string message =
          "Failed to connect '" + nativeSource + "' -> '" + nativeDestination + "'";
      os_log_error(ModuleLogger(), "%{public}s", message.c_str());
      RejectPromise(fail, @"connect_failed", message);
      return;
    }
    finish(nil);
  });
}

RCT_EXPORT_METHOD(disconnectNodes:(NSString*)source
                  destination:(NSString*)destination
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"disconnect_failed", @"Disconnect audio nodes", resolve,
                          ^(RCTPromiseResolveBlock finish, RCTPromiseRejectBlock fail) {
    if (source.length == 0 || destination.length == 0) {
      RejectPromise(fail, @"invalid_arguments", "source and destination are required");
      return;
    }
    const auto generation = self.engineGeneration;
    AudioEngineBridge::disconnect(generation, ToStdString(source, "source"),
                                  ToStdString(destination, "destination"));
    finish(nil);
  });
}

RCT_EXPORT_METHOD(scheduleParameterAutomation:(NSString*)nodeId
                  parameter:(NSString*)parameter
                  frame:(nonnull NSNumber*)frame
                  value:(double)value
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"automation_failed", @"Schedule parameter automation", resolve,
                          ^(RCTPromiseResolveBlock finish, RCTPromiseRejectBlock fail) {
    if (nodeId.length == 0 || parameter.length == 0 || frame == nil) {
      RejectPromise(fail, @"invalid_arguments", "nodeId, parameter, and frame are required");
      return;
    }
    const double frameValue = frame.doubleValue;
    if (!std::isfinite(frameValue) || frameValue < 0.0) {
      RejectPromise(fail, @"invalid_arguments", "frame must be a non-negative integer");
      return;
    }
    if (!std::isfinite(value)) {
      RejectPromise(fail, @"invalid_arguments", "value must be finite");
      return;
    }
    const unsigned long long frameTicks = frame.unsignedLongLongValue;
    const double diff = std::fabs(frameValue - static_cast<double>(frameTicks));
    if (diff > 1e-6) {
      RejectPromise(fail, @"invalid_arguments", "frame must be a non-negative integer");
      return;
    }
    const auto generation = self.engineGeneration;
    AudioEngineBridge::scheduleParameterAutomation(
        generation, ToStdString(nodeId, "nodeId"),
        ToStdString([parameter lowercaseString], "parameter"), frameTicks, value);
    finish(nil);
  });
}

RCT_EXPORT_METHOD(startTransport:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"transport_start_failed", @"Audio transport start", resolve,
                          ^(RCTPromiseResolveBlock finish, RCTPromiseRejectBlock fail) {
    BOOL startedDeviceForRequest = NO;
    try {
      @try {
        const auto generation = self.engineGeneration;
        if (!self.engineConfigured || self.configuredSampleRate <= 0.0 ||
            self.configuredFramesPerBuffer == 0 ||
            !AudioEngineBridge::isInitialized(generation)) {
          fail(@"transport_start_failed", @"Audio engine is not initialized", nil);
          return;
        }

        if (self.deviceStarted && ![self.deviceDriver isRunning]) {
          self.deviceStarted = NO;
          os_log_info(ModuleLogger(), "Rebuilding an audio device route that is no longer running");
        }

        if (!self.deviceStarted) {
          NSError* deviceError = nil;
          if (![self.deviceDriver startWithSampleRate:self.configuredSampleRate
                                     framesPerBuffer:self.configuredFramesPerBuffer
                                    engineGeneration:generation
                                               error:&deviceError]) {
            fail(@"transport_start_failed", @"Unable to start the iOS audio device", deviceError);
            return;
          }
          self.deviceStarted = YES;
          startedDeviceForRequest = YES;
        }

        AudioEngineBridge::startTransport(generation);
        finish(nil);
      } @catch (NSException* exception) {
        [self stopDeviceSafelyForOperation:@"Audio device cleanup after transport start exception"];
        RejectObjectiveCException(fail, @"transport_start_failed", @"Audio transport start",
                                  exception);
      }
    } catch (const std::exception& ex) {
      if (startedDeviceForRequest) {
        [self stopDeviceSafelyForOperation:@"Audio device cleanup after transport start failure"];
      }
      RejectPromise(fail, @"transport_start_failed", ex.what());
    } catch (...) {
      if (startedDeviceForRequest) {
        [self stopDeviceSafelyForOperation:@"Audio device cleanup after transport start failure"];
      }
      fail(@"transport_start_failed", @"Audio transport failed to start", nil);
    }
  });
}

RCT_EXPORT_METHOD(stopTransport:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"transport_stop_failed", @"Audio transport stop", resolve,
                          ^(RCTPromiseResolveBlock finish, RCTPromiseRejectBlock fail) {
    try {
      @try {
        const auto generation = self.engineGeneration;
        AudioEngineBridge::stopTransport(generation);
        if (self.deviceStarted) {
          [self stopDeviceSafelyForOperation:@"Audio device transport stop"];
        }
        finish(nil);
      } @catch (NSException* exception) {
        if (self.deviceStarted) {
          [self stopDeviceSafelyForOperation:@"Audio device cleanup after transport stop exception"];
        }
        RejectObjectiveCException(fail, @"transport_stop_failed", @"Audio transport stop",
                                  exception);
      }
    } catch (const std::exception& ex) {
      if (self.deviceStarted) {
        [self stopDeviceSafelyForOperation:@"Audio device cleanup after transport stop failure"];
      }
      RejectPromise(fail, @"transport_stop_failed", ex.what());
    } catch (...) {
      if (self.deviceStarted) {
        [self stopDeviceSafelyForOperation:@"Audio device cleanup after transport stop failure"];
      }
      fail(@"transport_stop_failed", @"Audio transport failed to stop", nil);
    }
  });
}

RCT_EXPORT_METHOD(locateTransport:(nonnull NSNumber*)frame
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"transport_locate_failed", @"Locate audio transport", resolve,
                          ^(RCTPromiseResolveBlock finish, RCTPromiseRejectBlock fail) {
    if (frame == nil || !std::isfinite(frame.doubleValue) || frame.doubleValue < 0.0 ||
        std::floor(frame.doubleValue) != frame.doubleValue) {
      RejectPromise(fail, @"invalid_arguments", "frame must be a non-negative integer");
      return;
    }
    const auto generation = self.engineGeneration;
    AudioEngineBridge::locateTransport(generation, frame.unsignedLongLongValue);
    finish(nil);
  });
}

RCT_EXPORT_METHOD(getTransportState:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"transport_state_failed", @"Read audio transport state", resolve,
                          ^(RCTPromiseResolveBlock finish, RCTPromiseRejectBlock fail) {
    const auto generation = self.engineGeneration;
    const auto state = AudioEngineBridge::getTransportState(generation);
    finish(@{
      @"currentFrame" : @(static_cast<unsigned long long>(state.currentFrame)),
      @"isPlaying" : @(state.isPlaying),
    });
  });
}

RCT_EXPORT_METHOD(getRenderDiagnostics:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"diagnostics_failed", @"Read audio render diagnostics", resolve,
                          ^(RCTPromiseResolveBlock finish, RCTPromiseRejectBlock fail) {
    const auto generation = self.engineGeneration;
    const auto diagnostics = AudioEngineBridge::getDiagnostics(generation);
    finish(@{
      @"xruns" : @(static_cast<NSInteger>(diagnostics.xruns)),
      @"lastRenderDurationMicros" : @(diagnostics.lastRenderDurationMicros),
      @"clipBufferBytes" : @(static_cast<NSInteger>(diagnostics.clipBufferBytes)),
      @"initialized" : @(self.engineConfigured && diagnostics.initialized),
    });
  });
}

@end
