#import "AudioDeviceDriver.h"

#import <AVFoundation/AVFoundation.h>

#include <algorithm>
#include <array>
#include <cstring>

#import "audio-engine/platform/ios/AudioEngineBridge.hpp"
#import "audio_engine/SceneGraph.h"

using daft::audio::SceneGraph;
using daft::audio::bridge::AudioEngineBridge;

@interface DaftAudioDeviceDriver ()
@property(nonatomic, strong, nullable) AVAudioEngine* engine;
@property(nonatomic, strong, nullable) AVAudioSourceNode* sourceNode;
@end

@implementation DaftAudioDeviceDriver

- (BOOL)startWithSampleRate:(double)sampleRate
            framesPerBuffer:(NSUInteger)framesPerBuffer
                      error:(NSError**)error {
  [self stop];

  AVAudioSession* session = [AVAudioSession sharedInstance];
  if (![session setCategory:AVAudioSessionCategoryPlayback
                       mode:AVAudioSessionModeDefault
                    options:AVAudioSessionCategoryOptionMixWithOthers
                      error:error] ||
      ![session setPreferredSampleRate:sampleRate error:error] ||
      ![session setPreferredIOBufferDuration:(double)framesPerBuffer / sampleRate error:error] ||
      ![session setActive:YES error:error]) {
    return NO;
  }

  AVAudioFormat* format = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:sampleRate channels:2];
  if (format == nil) {
    if (error != nullptr) {
      *error = [NSError errorWithDomain:@"DaftAudioDevice"
                                   code:1
                               userInfo:@{NSLocalizedDescriptionKey : @"Unable to create the output format"}];
    }
    return NO;
  }

  AVAudioSourceNodeRenderBlock renderBlock =
      ^OSStatus(BOOL* isSilence, const AudioTimeStamp*, AVAudioFrameCount frameCount,
                AudioBufferList* outputData) {
        const auto channels = std::min<std::size_t>(format.channelCount, SceneGraph::maxSupportedChannels());
        if (outputData == nullptr || channels == 0) {
          if (isSilence != nullptr) {
            *isSilence = YES;
          }
          return noErr;
        }

        const auto frames = static_cast<std::size_t>(frameCount);
        const auto zeroOutput = [outputData]() {
          for (UInt32 index = 0; index < outputData->mNumberBuffers; ++index) {
            AudioBuffer& buffer = outputData->mBuffers[index];
            if (buffer.mData != nullptr && buffer.mDataByteSize > 0) {
              std::memset(buffer.mData, 0, buffer.mDataByteSize);
            }
          }
        };
        if (frames > SceneGraph::maxSupportedFramesPerBuffer()) {
          zeroOutput();
          if (isSilence != nullptr) {
            *isSilence = YES;
          }
          return noErr;
        }

        if (outputData->mNumberBuffers >= channels) {
          std::array<float*, SceneGraph::maxSupportedChannels()> channelPointers{};
          for (std::size_t channel = 0; channel < channels; ++channel) {
            channelPointers[channel] = static_cast<float*>(outputData->mBuffers[channel].mData);
            if (channelPointers[channel] == nullptr) {
              zeroOutput();
              if (isSilence != nullptr) {
                *isSilence = YES;
              }
              return noErr;
            }
          }
          AudioEngineBridge::render(channelPointers.data(), channels, frames);
        } else if (outputData->mNumberBuffers == 1 && outputData->mBuffers[0].mData != nullptr) {
          auto* interleaved = static_cast<float*>(outputData->mBuffers[0].mData);
          using PlanarBuffer = std::array<
              std::array<float, SceneGraph::maxSupportedFramesPerBuffer()>,
              SceneGraph::maxSupportedChannels()>;
          thread_local PlanarBuffer planar{};
          std::array<float*, SceneGraph::maxSupportedChannels()> channelPointers{};
          for (std::size_t channel = 0; channel < channels; ++channel) {
            channelPointers[channel] = planar[channel].data();
          }
          AudioEngineBridge::render(channelPointers.data(), channels, frames);
          for (std::size_t frame = 0; frame < frames; ++frame) {
            for (std::size_t channel = 0; channel < channels; ++channel) {
              interleaved[frame * channels + channel] = planar[channel][frame];
            }
          }
        } else {
          zeroOutput();
          if (isSilence != nullptr) {
            *isSilence = YES;
          }
          return noErr;
        }
        if (isSilence != nullptr) {
          *isSilence = NO;
        }
        return noErr;
      };

  AVAudioEngine* engine = [[AVAudioEngine alloc] init];
  AVAudioSourceNode* sourceNode = [[AVAudioSourceNode alloc] initWithFormat:format renderBlock:renderBlock];
  [engine attachNode:sourceNode];
  [engine connect:sourceNode to:engine.mainMixerNode format:format];
  [engine prepare];
  if (![engine startAndReturnError:error]) {
    [engine detachNode:sourceNode];
    [session setActive:NO error:nil];
    return NO;
  }

  self.engine = engine;
  self.sourceNode = sourceNode;
  return YES;
}

- (void)stop {
  AVAudioEngine* engine = self.engine;
  AVAudioSourceNode* sourceNode = self.sourceNode;
  self.engine = nil;
  self.sourceNode = nil;
  if (engine != nil) {
    [engine stop];
    if (sourceNode != nil) {
      [engine disconnectNodeOutput:sourceNode];
      [engine detachNode:sourceNode];
    }
  }
  [[AVAudioSession sharedInstance] setActive:NO
                                 withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
                                       error:nil];
}

- (void)dealloc {
  [self stop];
}

@end
