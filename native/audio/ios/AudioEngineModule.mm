#import "AudioEngineModule.h"

#import "AudioDeviceDriver.h"
#import <React/RCTConvert.h>
#import <os/log.h>

#include <algorithm>
#include <cmath>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <exception>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

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
      converted.setNumeric(normalizedKey, [value doubleValue]);
    } else if ([value isKindOfClass:[NSString class]]) {
      NSString* stringValue = (NSString*)value;
      std::string trimmed = Trim([stringValue UTF8String] ? [stringValue UTF8String] : "");
      if (trimmed.empty()) {
        continue;
      }
      daft::audio::bridge::detail::storeStringOption(converted, normalizedKey,
                                                     trimmed);
    }
  }
  return converted;
}

NSString* NSStringFromStdString(const std::string& value) {
  NSString* converted = [NSString stringWithUTF8String:value.c_str()];
  return converted ?: @"Native audio operation failed";
}

NSDictionary* GraphDescriptionDictionary(
    const daft::audio::GraphDescription& description) {
  NSMutableArray<NSString*>* nodeIds =
      [NSMutableArray arrayWithCapacity:description.nodeIds.size()];
  for (const auto& nodeId : description.nodeIds) {
    [nodeIds addObject:NSStringFromStdString(nodeId)];
  }
  return @{
    @"generation" :
        @(static_cast<unsigned long long>(description.generation)),
    @"graphHash" : NSStringFromStdString(description.graphHash),
    @"nodeIds" : nodeIds,
    @"routeEpoch" :
        @(static_cast<unsigned long long>(description.routeEpoch)),
    @"engineInstance" :
        @(static_cast<unsigned long long>(description.engineInstance)),
  };
}

NSDictionary* GraphApplyResultDictionary(
    const daft::audio::GraphApplyResult& result) {
  NSMutableDictionary* dictionary = [@{
    @"status" :
        NSStringFromStdString(daft::audio::GraphApplyStatusName(result.status)),
    @"transactionId" : NSStringFromStdString(result.transactionId),
    @"graph" : GraphDescriptionDictionary(result.graph),
  } mutableCopy];
  if (result.failure.has_value()) {
    const auto& failure = *result.failure;
    dictionary[@"failure"] = @{
      @"stage" : NSStringFromStdString(
          daft::audio::GraphFailureStageName(failure.stage)),
      @"code" :
          NSStringFromStdString(daft::audio::GraphErrorCodeName(failure.code)),
      @"nodeId" : NSStringFromStdString(failure.nodeId),
      @"detail" : NSStringFromStdString(failure.detail),
    };
  }
  return dictionary;
}

bool ReadUnsignedGraphField(NSDictionary* dictionary, NSString* key,
                            std::uint64_t& output, std::string& error) {
  id raw = dictionary[key];
  if (![raw isKindOfClass:[NSNumber class]]) {
    error = std::string([key UTF8String]) + " must be numeric";
    return false;
  }
  const double value = [(NSNumber*)raw doubleValue];
  if (!std::isfinite(value) || value < 0.0 || std::floor(value) != value ||
      value > static_cast<double>(
                  std::numeric_limits<std::uint64_t>::max())) {
    error = std::string([key UTF8String]) +
            " must be a non-negative integer";
    return false;
  }
  output = [(NSNumber*)raw unsignedLongLongValue];
  return true;
}

std::string CanonicalOptionsFingerprint(NSDictionary* options,
                                        std::string& error) {
  if (options == nil || options.count == 0) {
    return "{}";
  }
  NSArray* rawKeys = [options allKeys];
  for (id rawKey in rawKeys) {
    if (![rawKey isKindOfClass:[NSString class]]) {
      error = "Node option keys must be strings";
      return {};
    }
  }
  NSArray<NSString*>* sortedKeys =
      [rawKeys sortedArrayUsingSelector:@selector(compare:)];
  NSMutableDictionary* normalizedOptions =
      [NSMutableDictionary dictionaryWithCapacity:options.count];
  for (NSString* key in sortedKeys) {
    const std::string normalizedKey = NormalizeKey(key);
    NSString* fingerprintKey =
        [NSString stringWithUTF8String:normalizedKey.c_str()];
    if (fingerprintKey == nil) {
      error = "Unable to normalize node option key";
      return {};
    }
    normalizedOptions[fingerprintKey] = options[key];
  }
  if (![NSJSONSerialization isValidJSONObject:normalizedOptions]) {
    error = "Node options must contain JSON-compatible values";
    return {};
  }
  NSError* serializationError = nil;
  NSData* data =
      [NSJSONSerialization dataWithJSONObject:normalizedOptions
                                      options:NSJSONWritingSortedKeys
                                        error:&serializationError];
  if (data == nil) {
    error = serializationError.localizedDescription.UTF8String
                ? serializationError.localizedDescription.UTF8String
                : "Unable to canonicalize node options";
    return {};
  }
  return std::string(static_cast<const char*>(data.bytes), data.length);
}

void RejectPromise(RCTPromiseRejectBlock reject, NSString* code, const std::string& message) {
  reject(code, NSStringFromStdString(message), nil);
}

void RejectObjectiveCException(RCTPromiseRejectBlock reject, NSString* code,
                               NSString* operation, id exception) {
  const BOOL isNativeException = [exception isKindOfClass:[NSException class]];
  NSException* nativeException =
      isNativeException ? (NSException*)exception : nil;
  NSString* reason =
      nativeException.reason ?: [exception description] ?: @"No exception reason supplied";
  NSString* exceptionName =
      nativeException.name ?: NSStringFromClass([exception class]) ?: @"Objective-C exception";
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

void LogObjectiveCException(NSString* operation, id exception) {
  const BOOL isNativeException = [exception isKindOfClass:[NSException class]];
  NSException* nativeException =
      isNativeException ? (NSException*)exception : nil;
  os_log_error(ModuleLogger(), "%{public}@ raised %{public}@: %{public}@",
               operation,
               nativeException.name ?: NSStringFromClass([exception class]) ?:
                   @"Objective-C exception",
               nativeException.reason ?: [exception description] ?:
                   @"No exception reason supplied");
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
    } @catch (id exception) {
      RejectObjectiveCException(captureReject, code, operation, exception);
    }
  } catch (const std::exception& ex) {
    os_log_error(ModuleLogger(), "%{public}@ failed: %{public}s", operation, ex.what());
    RejectPromise(captureReject, code, ex.what());
  } catch (...) {
    NSString* message =
        [NSString stringWithFormat:@"%@ failed with an unknown native exception",
                                   operation];
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
  } @catch (id exception) {
    LogObjectiveCException([operation stringByAppendingString:@" promise settlement"], exception);
  }
}

void ShutdownBridgeIfOwner(NSString* operation,
                           AudioEngineBridge::EngineGeneration generation) {
  if (generation == 0) {
    return;
  }
  (void)AudioEngineBridge::invalidateGraphTransactions(generation);
  if (!AudioEngineBridge::shutdownIfOwner(generation)) {
    os_log_info(ModuleLogger(), "%{public}@ did not own generation %llu", operation,
                static_cast<unsigned long long>(generation));
  }
}

bool EnsureInitialized(AudioEngineBridge::EngineGeneration generation, RCTPromiseRejectBlock reject) {
  if (generation != 0) {
    return true;
  }
  RejectPromise(reject, @"engine_not_initialized", "Audio engine is not initialized");
  return false;
}

void StopTransportSilently(AudioEngineBridge::EngineGeneration generation) noexcept {
  try {
    if (generation != 0) {
      AudioEngineBridge::stopTransport(generation);
    }
  } catch (...) {
    os_log_error(ModuleLogger(), "Failed to stop transport during recovery");
  }
}

bool ReadFrameArgument(double value, NSString* name, std::uint64_t& out,
                       RCTPromiseRejectBlock reject) {
  if (!std::isfinite(value) || value < 0.0) {
    NSString* message = [NSString stringWithFormat:@"%@ must be non-negative and finite", name];
    RejectPromise(reject, @"invalid_arguments", [message UTF8String]);
    return false;
  }
  const double rounded = std::floor(value);
  if (std::fabs(value - rounded) > 1e-6) {
    NSString* message = [NSString stringWithFormat:@"%@ must be an integer value", name];
    RejectPromise(reject, @"invalid_arguments", [message UTF8String]);
    return false;
  }
  if (rounded > static_cast<double>(std::numeric_limits<std::uint64_t>::max())) {
    NSString* message = [NSString stringWithFormat:@"%@ exceeds platform limits", name];
    RejectPromise(reject, @"invalid_arguments", [message UTF8String]);
    return false;
  }
  out = static_cast<std::uint64_t>(rounded);
  return true;
}

std::optional<daft::audio::InstrumentEventType> ConvertInstrumentEventType(NSNumber* value) {
  if (value == nil) {
    return std::nullopt;
  }
  switch (value.integerValue) {
    case 0:
      return daft::audio::InstrumentEventType::kNoteOn;
    case 1:
      return daft::audio::InstrumentEventType::kNoteOff;
    case 2:
      return daft::audio::InstrumentEventType::kControlChange;
    case 3:
      return daft::audio::InstrumentEventType::kPitchBend;
    case 4:
      return daft::audio::InstrumentEventType::kChannelAftertouch;
    case 5:
      return daft::audio::InstrumentEventType::kPolyAftertouch;
    default:
      return std::nullopt;
  }
}

bool ReadBoundedInteger(NSDictionary* event, NSString* key, NSInteger minimum,
                        NSInteger maximum, NSInteger& out) {
  id value = event[key];
  if (![value isKindOfClass:[NSNumber class]]) {
    return false;
  }
  NSNumber* number = (NSNumber*)value;
  const double raw = number.doubleValue;
  if (!std::isfinite(raw)) {
    return false;
  }
  const NSInteger integer = number.integerValue;
  if (std::fabs(raw - static_cast<double>(integer)) > 1e-6 ||
      integer < minimum || integer > maximum) {
    return false;
  }
  out = integer;
  return true;
}
}  // namespace

@interface AudioEngineModule ()
@property(nonatomic, strong) DaftAudioDeviceDriver* audioDeviceDriver;
@property(nonatomic, assign) double configuredSampleRate;
@property(nonatomic, assign) NSUInteger configuredFramesPerBuffer;
@end

@implementation AudioEngineModule {
  AudioEngineBridge::EngineGeneration _engineGeneration;
  BOOL _isRecoveringAudioConfiguration;
  NSUInteger _audioConfigurationNotificationSequence;
  NSString* _audioConfigurationRecoveryError;
}

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _engineGeneration = 0;
    _audioDeviceDriver = [[DaftAudioDeviceDriver alloc] init];
    _isRecoveringAudioConfiguration = NO;
    _audioConfigurationNotificationSequence = 0U;
    _audioConfigurationRecoveryError = nil;
    __weak AudioEngineModule* weakSelf = self;
    _audioDeviceDriver.audioConfigurationChangeHandler =
        ^(NSString* notificationName) {
          AudioEngineModule* strongSelf = weakSelf;
          if (strongSelf == nil) {
            return;
          }
          dispatch_async([strongSelf methodQueue], ^{
            strongSelf->_audioConfigurationNotificationSequence += 1U;
            const NSUInteger sequence =
                strongSelf->_audioConfigurationNotificationSequence;
            dispatch_after(
                dispatch_time(DISPATCH_TIME_NOW,
                              50LL * NSEC_PER_MSEC),
                [strongSelf methodQueue], ^{
                  if (sequence !=
                          strongSelf
                              ->_audioConfigurationNotificationSequence) {
                    return;
                  }
                  [strongSelf
                      recoverAfterAudioConfigurationChange:
                          notificationName];
                });
          });
        };
    _configuredSampleRate = 0.0;
    _configuredFramesPerBuffer = 0U;
  }
  return self;
}

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

- (void)recoverAfterAudioConfigurationChange:(NSString*)notificationName {
  if (_isRecoveringAudioConfiguration || _engineGeneration == 0) {
    return;
  }
  _isRecoveringAudioConfiguration = YES;
  @try {
    try {
      const auto generation = _engineGeneration;
      const auto transport =
          AudioEngineBridge::getTransportState(generation);
      [self.audioDeviceDriver stop];
      AudioEngineBridge::stopTransport(generation);

      const auto recovery =
          AudioEngineBridge::recoverAfterAudioConfigurationChange(
              generation);
      if (recovery.status !=
          daft::audio::GraphApplyStatus::Committed) {
        const std::string detail =
            recovery.failure.has_value()
                ? recovery.failure->detail
                : "Native graph recovery was rejected";
        os_log_error(
            ModuleLogger(),
            "Audio configuration recovery failed after %{public}@: %{public}s",
            notificationName, detail.c_str());
        _audioConfigurationRecoveryError =
            [NSString stringWithFormat:@"Audio configuration recovery failed: %@",
                                       NSStringFromStdString(detail)];
        return;
      }

      // A paused transport intentionally leaves the device stopped; recovery
      // must not turn a route notification into implicit playback.
      if (transport.isPlaying) {
        AudioEngineBridge::locateTransport(
            generation, transport.currentFrame);
        AudioEngineBridge::startTransport(generation);
        NSError* deviceError = nil;
        if (![self.audioDeviceDriver
                startWithSampleRate:self.configuredSampleRate
                   framesPerBuffer:self.configuredFramesPerBuffer
                  engineGeneration:generation
                             error:&deviceError]) {
          StopTransportSilently(generation);
          os_log_error(
              ModuleLogger(),
              "Audio device restart failed after %{public}@: %{public}@",
              notificationName,
              deviceError.localizedDescription ?:
                  @"No device error was supplied");
          _audioConfigurationRecoveryError =
              [NSString stringWithFormat:@"Audio device restart failed: %@",
                                         deviceError.localizedDescription ?:
                                             @"No device error was supplied"];
          return;
        }
      }

      _audioConfigurationRecoveryError = nil;
      os_log_info(
          ModuleLogger(),
          "Recovered audio graph after %{public}@ (route epoch %llu)",
          notificationName,
          static_cast<unsigned long long>(
              recovery.graph.routeEpoch));
    } catch (const std::exception& exception) {
      StopTransportSilently(_engineGeneration);
      _audioConfigurationRecoveryError =
          [NSString stringWithUTF8String:exception.what()];
      os_log_error(
          ModuleLogger(),
          "Audio configuration recovery failed after %{public}@: %{public}s",
          notificationName, exception.what());
    } catch (...) {
      StopTransportSilently(_engineGeneration);
      _audioConfigurationRecoveryError =
          @"Audio configuration recovery failed";
      os_log_error(
          ModuleLogger(),
          "Audio configuration recovery failed after %{public}@",
          notificationName);
    }
  } @catch (NSException* exception) {
    StopTransportSilently(_engineGeneration);
    _audioConfigurationRecoveryError =
        exception.reason ?: @"Audio configuration recovery failed";
    LogObjectiveCException(
        @"Audio configuration recovery", exception);
  } @finally {
    _isRecoveringAudioConfiguration = NO;
  }
}

- (void)invalidate {
  _audioConfigurationNotificationSequence += 1U;
  @try {
    [self.audioDeviceDriver stop];
  } @catch (NSException* exception) {
    LogObjectiveCException(@"Audio engine invalidation", exception);
  }
  const auto generation = _engineGeneration;
  _engineGeneration = 0;
  self.configuredSampleRate = 0.0;
  self.configuredFramesPerBuffer = 0U;
  _audioConfigurationRecoveryError = nil;
  ShutdownBridgeIfOwner(@"Audio engine invalidation", generation);
}

- (void)dealloc {
  [self invalidate];
}

RCT_EXPORT_METHOD(initialize:(double)sampleRate
                  framesPerBuffer:(nonnull NSNumber*)framesPerBuffer
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"initialize_failed", @"Audio engine initialization", resolve,
                          ^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
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
    const auto generation =
        AudioEngineBridge::initialize(sampleRate, framesUnsigned);
    const auto graphInitialization =
        AudioEngineBridge::initializeGraphTransactions(
            generation, sampleRate, framesUnsigned);
    if (graphInitialization.status !=
        daft::audio::GraphApplyStatus::Committed) {
      const std::string detail =
          graphInitialization.failure.has_value()
              ? graphInitialization.failure->detail
              : "Native graph transaction initialization failed";
      ShutdownBridgeIfOwner(@"Failed graph initialization", generation);
      RejectPromise(reject, @"initialize_failed", detail);
      return;
    }
    _engineGeneration = generation;
    self.configuredSampleRate = sampleRate;
    self.configuredFramesPerBuffer = framesUnsigned;
    _audioConfigurationRecoveryError = nil;
    resolve(nil);
  } catch (const std::exception& ex) {
    os_log_error(ModuleLogger(), "Initialize failed: %{public}s", ex.what());
    RejectPromise(reject, @"initialize_failed", ex.what());
  }
  });
}

RCT_EXPORT_METHOD(shutdown:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"shutdown_failed", @"Audio engine shutdown", resolve,
                          ^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
  try {
    [self.audioDeviceDriver stop];
    const auto generation = _engineGeneration;
    _engineGeneration = 0;
    if (generation != 0) {
      ShutdownBridgeIfOwner(@"Audio engine shutdown", generation);
    }
    self.configuredSampleRate = 0.0;
    self.configuredFramesPerBuffer = 0U;
    _audioConfigurationRecoveryError = nil;
    resolve(nil);
  } catch (const std::exception& ex) {
    os_log_error(ModuleLogger(), "Shutdown failed: %{public}s", ex.what());
    RejectPromise(reject, @"shutdown_failed", ex.what());
  }
  });
}

RCT_EXPORT_METHOD(startTransport:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"transport_start_failed", @"Audio transport start", resolve,
                          ^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
  const auto generation = _engineGeneration;
  if (!EnsureInitialized(generation, reject)) {
    return;
  }
  if (self.configuredSampleRate <= 0.0 || self.configuredFramesPerBuffer == 0U) {
    RejectPromise(reject, @"transport_start_failed", "Audio engine configuration is unavailable");
    return;
  }

  try {
    AudioEngineBridge::startTransport(generation);
  } catch (const std::exception& ex) {
    os_log_error(ModuleLogger(), "startTransport failed: %{public}s", ex.what());
    RejectPromise(reject, @"transport_start_failed", ex.what());
    return;
  }

  NSError* deviceError = nil;
  @try {
    if (![self.audioDeviceDriver startWithSampleRate:self.configuredSampleRate
                                     framesPerBuffer:self.configuredFramesPerBuffer
                                    engineGeneration:generation
                                               error:&deviceError]) {
      StopTransportSilently(generation);
      NSString* message =
          deviceError.localizedDescription ?: @"Unable to start the audio device";
      reject(@"transport_start_failed", message, deviceError);
      return;
    }
  } @catch (NSException* exception) {
    StopTransportSilently(generation);
    NSString* message = exception.reason ?: exception.name;
    reject(@"transport_start_failed", message, nil);
    return;
  }

  resolve(nil);
  });
}

RCT_EXPORT_METHOD(stopTransport:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"transport_stop_failed", @"Audio transport stop", resolve,
                          ^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
  const auto generation = _engineGeneration;
  if (!EnsureInitialized(generation, reject)) {
    return;
  }
  @try {
    [self.audioDeviceDriver stop];
  } @catch (NSException* exception) {
    NSString* message = exception.reason ?: exception.name;
    reject(@"transport_stop_failed", message, nil);
    return;
  }
  try {
    AudioEngineBridge::stopTransport(generation);
    resolve(nil);
  } catch (const std::exception& ex) {
    os_log_error(ModuleLogger(), "stopTransport failed: %{public}s", ex.what());
    RejectPromise(reject, @"transport_stop_failed", ex.what());
  }
  });
}

RCT_EXPORT_METHOD(locateTransport:(double)frame
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"transport_locate_failed", @"Locate audio transport", resolve,
                          ^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
  const auto generation = _engineGeneration;
  if (!EnsureInitialized(generation, reject)) {
    return;
  }
  std::uint64_t nativeFrame = 0U;
  if (!ReadFrameArgument(frame, @"frame", nativeFrame, reject)) {
    return;
  }
  try {
    AudioEngineBridge::locateTransport(generation, nativeFrame);
    resolve(nil);
  } catch (const std::exception& ex) {
    os_log_error(ModuleLogger(), "locateTransport failed: %{public}s", ex.what());
    RejectPromise(reject, @"transport_locate_failed", ex.what());
  }
  });
}

RCT_EXPORT_METHOD(setTransportLoop:(double)startFrame
                  endFrame:(double)endFrame
                  enabled:(BOOL)enabled
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"transport_loop_failed", @"Set audio transport loop", resolve,
                          ^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
  const auto generation = _engineGeneration;
  if (!EnsureInitialized(generation, reject)) {
    return;
  }
  std::uint64_t nativeStartFrame = 0U;
  std::uint64_t nativeEndFrame = 0U;
  if (!ReadFrameArgument(startFrame, @"startFrame", nativeStartFrame, reject) ||
      !ReadFrameArgument(endFrame, @"endFrame", nativeEndFrame, reject)) {
    return;
  }
  try {
    AudioEngineBridge::setTransportLoop(generation, nativeStartFrame, nativeEndFrame, enabled);
    resolve(nil);
  } catch (const std::exception& ex) {
    os_log_error(ModuleLogger(), "setTransportLoop failed: %{public}s", ex.what());
    RejectPromise(reject, @"transport_loop_failed", ex.what());
  }
  });
}

RCT_EXPORT_METHOD(getTransportState:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"transport_state_failed", @"Read audio transport state", resolve,
                          ^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
  const auto generation = _engineGeneration;
  if (!EnsureInitialized(generation, reject)) {
    return;
  }
  try {
    const auto state = AudioEngineBridge::getTransportState(generation);
    const auto currentFrame = static_cast<double>(state.currentFrame);
    resolve(@{
      @"currentFrame" : @(currentFrame),
      @"frame" : @(currentFrame),
      @"isPlaying" : @(state.isPlaying),
    });
  } catch (const std::exception& ex) {
    os_log_error(ModuleLogger(), "getTransportState failed: %{public}s", ex.what());
    RejectPromise(reject, @"transport_state_failed", ex.what());
  }
  });
}

RCT_EXPORT_METHOD(describeGraph:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(
      reject, @"describe_graph_failed", @"Describe audio graph", resolve,
      ^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
        const auto generation = _engineGeneration;
        if (!EnsureInitialized(generation, reject)) {
          return;
        }
        const auto description =
            AudioEngineBridge::describeGraph(generation);
        resolve(GraphDescriptionDictionary(description));
      });
}

RCT_EXPORT_METHOD(applyGraph:(NSDictionary*)request
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(
      reject, @"apply_graph_failed", @"Apply audio graph", resolve,
      ^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
        const auto generation = _engineGeneration;
        if (!EnsureInitialized(generation, reject)) {
          return;
        }
        if (![request isKindOfClass:[NSDictionary class]]) {
          RejectPromise(reject, @"invalid_arguments",
                        "Graph request must be an object");
          return;
        }

        id transactionValue = request[@"transactionId"];
        if (![transactionValue isKindOfClass:[NSString class]] ||
            [(NSString*)transactionValue length] == 0) {
          RejectPromise(reject, @"invalid_arguments",
                        "transactionId is required");
          return;
        }

        daft::audio::GraphApplyRequest nativeRequest;
        nativeRequest.transactionId =
            [(NSString*)transactionValue UTF8String];
        std::string conversionError;
        if (!ReadUnsignedGraphField(request, @"expectedGeneration",
                                    nativeRequest.expectedGeneration,
                                    conversionError) ||
            !ReadUnsignedGraphField(request, @"expectedRouteEpoch",
                                    nativeRequest.expectedRouteEpoch,
                                    conversionError) ||
            !ReadUnsignedGraphField(request, @"expectedEngineInstance",
                                    nativeRequest.expectedEngineInstance,
                                    conversionError)) {
          RejectPromise(reject, @"invalid_arguments", conversionError);
          return;
        }

        id rawNodes = request[@"nodes"];
        if (![rawNodes isKindOfClass:[NSArray class]]) {
          RejectPromise(reject, @"invalid_arguments",
                        "nodes must be an array");
          return;
        }
        NSArray* nodes = (NSArray*)rawNodes;
        nativeRequest.nodes.reserve(nodes.count);
        for (id rawNode in nodes) {
          if (![rawNode isKindOfClass:[NSDictionary class]]) {
            RejectPromise(reject, @"invalid_arguments",
                          "Every node must be an object");
            return;
          }
          NSDictionary* node = (NSDictionary*)rawNode;
          id rawNodeId = node[@"id"];
          id rawNodeType = node[@"type"];
          id rawOptions = node[@"options"];
          if (![rawNodeId isKindOfClass:[NSString class]] ||
              [(NSString*)rawNodeId length] == 0 ||
              ![rawNodeType isKindOfClass:[NSString class]] ||
              [(NSString*)rawNodeType length] == 0 ||
              (rawOptions != nil &&
               ![rawOptions isKindOfClass:[NSDictionary class]])) {
            RejectPromise(
                reject, @"invalid_arguments",
                "Each node needs non-empty id/type and object options");
            return;
          }

          const std::string nodeId =
              Trim([(NSString*)rawNodeId UTF8String]);
          const std::string nodeType =
              ToLowerCopy(Trim([(NSString*)rawNodeType UTF8String]));
          if (nodeId.empty() || nodeType.empty()) {
            RejectPromise(reject, @"invalid_arguments",
                          "Node id and type cannot contain only whitespace");
            return;
          }

          NSDictionary* options =
              [rawOptions isKindOfClass:[NSDictionary class]]
                  ? (NSDictionary*)rawOptions
                  : @{};
          NodeOptions nativeOptions = ConvertOptions(options);
          nativeOptions.engineGeneration = generation;
          std::string factoryError;
          auto nativeNode =
              CreateNode(nodeType, nativeOptions, factoryError);
          if (!nativeNode) {
            RejectPromise(reject, @"unsupported_node", factoryError);
            return;
          }

          std::string fingerprint =
              CanonicalOptionsFingerprint(options, conversionError);
          if (!conversionError.empty()) {
            RejectPromise(reject, @"invalid_arguments", conversionError);
            return;
          }

          daft::audio::PreparedGraphNode prepared;
          prepared.id = nodeId;
          prepared.type = nodeType;
          prepared.optionsFingerprint = std::move(fingerprint);
          prepared.node = std::move(nativeNode);
          nativeRequest.nodes.push_back(std::move(prepared));
        }

        id rawConnections = request[@"connections"];
        if (![rawConnections isKindOfClass:[NSArray class]]) {
          RejectPromise(reject, @"invalid_arguments",
                        "connections must be an array");
          return;
        }
        NSArray* connections = (NSArray*)rawConnections;
        nativeRequest.connections.reserve(connections.count);
        for (id rawConnection in connections) {
          if (![rawConnection isKindOfClass:[NSDictionary class]]) {
            RejectPromise(reject, @"invalid_arguments",
                          "Every connection must be an object");
            return;
          }
          NSDictionary* connection = (NSDictionary*)rawConnection;
          id rawSource = connection[@"source"];
          id rawDestination = connection[@"destination"];
          if (![rawSource isKindOfClass:[NSString class]] ||
              ![rawDestination isKindOfClass:[NSString class]]) {
            RejectPromise(
                reject, @"invalid_arguments",
                "Every connection needs source and destination strings");
            return;
          }
          daft::audio::GraphConnectionDefinition definition;
          definition.source =
              Trim([(NSString*)rawSource UTF8String]);
          definition.destination =
              Trim([(NSString*)rawDestination UTF8String]);
          if (definition.source.empty() ||
              definition.destination.empty()) {
            RejectPromise(
                reject, @"invalid_arguments",
                "Connection endpoints cannot contain only whitespace");
            return;
          }
          nativeRequest.connections.push_back(std::move(definition));
        }

        const auto result = AudioEngineBridge::applyGraph(
            generation, std::move(nativeRequest));
        resolve(GraphApplyResultDictionary(result));
      });
}

RCT_EXPORT_METHOD(addNode:(NSString*)nodeId
                  nodeType:(NSString*)nodeType
                  options:(NSDictionary*)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"add_node_failed", @"Add audio node", resolve,
                          ^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
  if (nodeId.length == 0 || nodeType.length == 0) {
    RejectPromise(reject, @"invalid_arguments", "nodeId and nodeType are required");
    return;
  }
  const auto generation = _engineGeneration;
  if (!EnsureInitialized(generation, reject)) {
    return;
  }
  NodeOptions nativeOptions = ConvertOptions(options);
  nativeOptions.engineGeneration = generation;
  std::string error;
  auto node = CreateNode([nodeType UTF8String], nativeOptions, error);
  if (!node) {
    os_log_error(ModuleLogger(), "Unsupported node type %{public}@", nodeType);
    RejectPromise(reject, @"unsupported_node", error);
    return;
  }
  const bool success = AudioEngineBridge::addNode(generation, [nodeId UTF8String], std::move(node));
  if (!success) {
    std::string message = "Failed to add node '" + std::string([nodeId UTF8String]) + "'";
    os_log_error(ModuleLogger(), "%{public}s", message.c_str());
    RejectPromise(reject, @"add_node_failed", message);
    return;
  }
  resolve(nil);
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
                          ^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
  const std::string key = Trim(bufferKey.length > 0 ? [bufferKey UTF8String] : "");
  if (key.empty()) {
    RejectPromise(reject, @"invalid_arguments", "bufferKey is required");
    return;
  }
  const auto generation = _engineGeneration;
  if (!EnsureInitialized(generation, reject)) {
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
    NSData* data = nil;
    if ([entry isKindOfClass:[NSData class]]) {
      data = (NSData*)entry;
    } else if ([entry isKindOfClass:[NSString class]]) {
      data = [[NSData alloc] initWithBase64EncodedString:(NSString*)entry
                                                options:NSDataBase64DecodingIgnoreUnknownCharacters];
    }
    if (data == nil) {
      RejectPromise(reject, @"invalid_arguments",
                    "channelData entries must be base64 Float32 PCM strings");
      return;
    }
    if (data.length < requiredBytes) {
      RejectPromise(reject, @"invalid_arguments", "channelData entry is smaller than the expected frame count");
      return;
    }
    std::vector<float> channel(frameCount);
    std::memcpy(channel.data(), data.bytes, requiredBytes);
    nativeChannels.push_back(std::move(channel));
  }

  const bool ok = AudioEngineBridge::registerClipBuffer(generation, key, sampleRate, channelCount, frameCount,
                                                        std::move(nativeChannels));
  if (!ok) {
    os_log_error(ModuleLogger(), "Failed to register clip buffer %{public}@", bufferKey);
    RejectPromise(reject, @"register_clip_failed", "Failed to register clip buffer");
    return;
  }
  resolve(nil);
  });
}

RCT_EXPORT_METHOD(unregisterClipBuffer:(NSString*)bufferKey
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"unregister_clip_failed", @"Unregister clip buffer", resolve,
                          ^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
  NSString* trimmedKey = [bufferKey stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (trimmedKey.length == 0) {
    RejectPromise(reject, @"invalid_arguments", "bufferKey is required");
    return;
  }
  const auto generation = _engineGeneration;
  if (!EnsureInitialized(generation, reject)) {
    return;
  }
  const bool ok = AudioEngineBridge::unregisterClipBuffer(generation, [trimmedKey UTF8String]);
  if (!ok) {
    os_log_error(ModuleLogger(), "Failed to unregister clip buffer %{public}@", trimmedKey);
    RejectPromise(reject, @"unregister_clip_failed", "Failed to unregister clip buffer");
    return;
  }
  resolve(nil);
  });
}

RCT_EXPORT_METHOD(removeNode:(NSString*)nodeId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"remove_node_failed", @"Remove audio node", resolve,
                          ^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
  if (nodeId.length == 0) {
    RejectPromise(reject, @"invalid_arguments", "nodeId is required");
    return;
  }
  const auto generation = _engineGeneration;
  if (!EnsureInitialized(generation, reject)) {
    return;
  }
  try {
    AudioEngineBridge::removeNode(generation, [nodeId UTF8String]);
    resolve(nil);
  } catch (const std::exception& ex) {
    os_log_error(ModuleLogger(), "removeNode failed: %{public}s", ex.what());
    RejectPromise(reject, @"remove_node_failed", ex.what());
  }
  });
}

RCT_EXPORT_METHOD(connectNodes:(NSString*)source
                  destination:(NSString*)destination
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"connect_failed", @"Connect audio nodes", resolve,
                          ^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
  if (source.length == 0 || destination.length == 0) {
    RejectPromise(reject, @"invalid_arguments", "source and destination are required");
    return;
  }
  const auto generation = _engineGeneration;
  if (!EnsureInitialized(generation, reject)) {
    return;
  }
  const bool ok = AudioEngineBridge::connect(generation, [source UTF8String], [destination UTF8String]);
  if (!ok) {
    std::string message = "Failed to connect '" + std::string([source UTF8String]) + "' -> '" +
                          std::string([destination UTF8String]) + "'";
    os_log_error(ModuleLogger(), "%{public}s", message.c_str());
    RejectPromise(reject, @"connect_failed", message);
    return;
  }
  resolve(nil);
  });
}

RCT_EXPORT_METHOD(disconnectNodes:(NSString*)source
                  destination:(NSString*)destination
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"disconnect_failed", @"Disconnect audio nodes", resolve,
                          ^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
  if (source.length == 0 || destination.length == 0) {
    RejectPromise(reject, @"invalid_arguments", "source and destination are required");
    return;
  }
  const auto generation = _engineGeneration;
  if (!EnsureInitialized(generation, reject)) {
    return;
  }
  try {
    AudioEngineBridge::disconnect(generation, [source UTF8String], [destination UTF8String]);
    resolve(nil);
  } catch (const std::exception& ex) {
    os_log_error(ModuleLogger(), "disconnectNodes failed: %{public}s", ex.what());
    RejectPromise(reject, @"disconnect_failed", ex.what());
  }
  });
}

RCT_EXPORT_METHOD(scheduleParameterAutomation:(NSString*)nodeId
                  parameter:(NSString*)parameter
                  frame:(nonnull NSNumber*)frame
                  value:(double)value
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"automation_failed", @"Schedule parameter automation", resolve,
                          ^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
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
  const auto generation = _engineGeneration;
  if (!EnsureInitialized(generation, reject)) {
    return;
  }
  const unsigned long long frameTicks = frame.unsignedLongLongValue;
  const double diff = std::fabs(frameValue - static_cast<double>(frameTicks));
  if (diff > 1e-6) {
    RejectPromise(reject, @"invalid_arguments", "frame must be a non-negative integer");
    return;
  }
  try {
    AudioEngineBridge::scheduleParameterAutomation(generation, [nodeId UTF8String], [parameter UTF8String],
                                                   frameTicks, value);
    resolve(nil);
  } catch (const std::exception& ex) {
    os_log_error(ModuleLogger(), "scheduleParameterAutomation failed: %{public}s", ex.what());
    RejectPromise(reject, @"automation_failed", ex.what());
  }
  });
}

RCT_EXPORT_METHOD(sendInstrumentMidi:(NSString*)nodeId
                  event:(NSDictionary*)event
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"instrument_event_failed", @"Send instrument MIDI", resolve,
                          ^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
  if (nodeId.length == 0 || event == nil) {
    RejectPromise(reject, @"invalid_arguments", "nodeId and event are required");
    return;
  }
  const auto generation = _engineGeneration;
  if (!EnsureInitialized(generation, reject)) {
    return;
  }

  auto eventType = ConvertInstrumentEventType(event[@"type"]);
  NSInteger channel = 0;
  NSInteger data1 = 0;
  NSInteger data2 = 0;
  if (!eventType ||
      !ReadBoundedInteger(event, @"channel", 0, 15, channel) ||
      !ReadBoundedInteger(event, @"data1", 0, 127, data1) ||
      !ReadBoundedInteger(event, @"data2", 0, 127, data2)) {
    RejectPromise(reject, @"invalid_arguments", "Invalid MIDI event payload");
    return;
  }

  std::uint64_t frameOffset = 0U;
  id rawFrameOffset = event[@"frameOffset"];
  if (rawFrameOffset != nil) {
    if (![rawFrameOffset isKindOfClass:[NSNumber class]]) {
      RejectPromise(reject, @"invalid_arguments", "frameOffset must be numeric");
      return;
    }
    NSNumber* frameNumber = (NSNumber*)rawFrameOffset;
    const double frameValue = frameNumber.doubleValue;
    if (!std::isfinite(frameValue) || frameValue < 0.0) {
      RejectPromise(reject, @"invalid_arguments", "frameOffset must be non-negative");
      return;
    }
    frameOffset = frameNumber.unsignedLongLongValue;
    if (std::fabs(frameValue - static_cast<double>(frameOffset)) > 1e-6) {
      RejectPromise(reject, @"invalid_arguments", "frameOffset must be an integer");
      return;
    }
  }

  daft::audio::InstrumentEvent nativeEvent{};
  nativeEvent.type = *eventType;
  nativeEvent.channel = static_cast<std::uint8_t>(channel);
  nativeEvent.data = static_cast<std::uint8_t>(data1);
  nativeEvent.value = static_cast<float>(data2) / 127.0F;
  nativeEvent.retainAcrossPanic = false;

  if (*eventType == daft::audio::InstrumentEventType::kChannelAftertouch) {
    nativeEvent.data = 0U;
    nativeEvent.value = static_cast<float>(data1) / 127.0F;
  } else if (*eventType == daft::audio::InstrumentEventType::kPitchBend) {
    const NSInteger bend = (data2 << 7) | data1;
    nativeEvent.data = 0U;
    nativeEvent.value = static_cast<float>(
        std::clamp((static_cast<double>(bend) - 8192.0) / 8192.0, -1.0, 1.0));
  }

  try {
    AudioEngineBridge::scheduleInstrumentEventFromNow(
        generation, [nodeId UTF8String], nativeEvent, frameOffset);
    resolve(nil);
  } catch (const std::exception& ex) {
    os_log_error(ModuleLogger(), "sendInstrumentMidi failed: %{public}s", ex.what());
    RejectPromise(reject, @"instrument_event_failed", ex.what());
  }
  });
}

RCT_EXPORT_METHOD(allNotesOff:(NSString*)nodeId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"all_notes_off_failed", @"All notes off", resolve,
                          ^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
  if (nodeId.length == 0) {
    RejectPromise(reject, @"invalid_arguments", "nodeId is required");
    return;
  }
  const auto generation = _engineGeneration;
  if (!EnsureInitialized(generation, reject)) {
    return;
  }
  try {
    AudioEngineBridge::allNotesOff(generation, [nodeId UTF8String]);
    resolve(nil);
  } catch (const std::exception& ex) {
    os_log_error(ModuleLogger(), "allNotesOff failed: %{public}s", ex.what());
    RejectPromise(reject, @"all_notes_off_failed", ex.what());
  }
  });
}

RCT_EXPORT_METHOD(getRenderDiagnostics:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  PerformPromiseOperation(reject, @"diagnostics_failed", @"Read audio render diagnostics", resolve,
                          ^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
  const auto generation = _engineGeneration;
  if (!EnsureInitialized(generation, reject)) {
    return;
  }
  if (_audioConfigurationRecoveryError != nil) {
    reject(@"audio_configuration_recovery_failed",
           _audioConfigurationRecoveryError, nil);
    return;
  }
  try {
    const auto diagnostics = AudioEngineBridge::getDiagnostics(generation);
    resolve(@{
      @"initialized" : @(diagnostics.initialized),
      @"xruns" : @(static_cast<NSInteger>(diagnostics.xruns)),
      @"lastRenderDurationMicros" : @(diagnostics.lastRenderDurationMicros),
      @"clipBufferBytes" : @(static_cast<NSInteger>(diagnostics.clipBufferBytes)),
      @"activeVoices" : @(static_cast<NSInteger>(diagnostics.activeVoices)),
      @"pendingInstrumentEvents" :
          @(static_cast<NSInteger>(diagnostics.pendingInstrumentEvents)),
      @"realtimeQueueDepth" : @(static_cast<NSInteger>(diagnostics.realtimeQueueDepth)),
      @"realtimeQueueOverflows" :
          @(static_cast<NSInteger>(diagnostics.realtimeQueueOverflows)),
      @"realtimeCommandFailures" :
          @(static_cast<NSInteger>(diagnostics.realtimeCommandFailures)),
      @"renderCount" : @(static_cast<NSInteger>(diagnostics.renderCount)),
      @"averageRenderDurationMicros" : @(diagnostics.averageRenderDurationMicros),
      @"maximumRenderDurationMicros" : @(diagnostics.maximumRenderDurationMicros),
      @"p50RenderDurationMicros" : @(diagnostics.p50RenderDurationMicros),
      @"p95RenderDurationMicros" : @(diagnostics.p95RenderDurationMicros),
      @"p99RenderDurationMicros" : @(diagnostics.p99RenderDurationMicros),
    });
  } catch (const std::exception& ex) {
    os_log_error(ModuleLogger(), "getRenderDiagnostics failed: %{public}s", ex.what());
    RejectPromise(reject, @"diagnostics_failed", ex.what());
  }
  });
}

@end
