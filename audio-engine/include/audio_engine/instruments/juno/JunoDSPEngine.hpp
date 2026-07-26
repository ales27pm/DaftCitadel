#pragma once

#include "audio_engine/instruments/juno/Juno106PatchParser.hpp"
#include "audio_engine/instruments/juno/JunoVoice.hpp"
#include "audio_engine/instruments/juno/RCUParameterManager.hpp"

#include <atomic>
#include <memory>
#include <string>
#include <vector>

class JunoDSPEngine {
 public:
  bool initialize(int sampleRate, int bufferSize, int polyphony);
  void start();
  void stop();
  void noteOn(int midiNote, float velocity);
  void noteOff(int midiNote);

  void setParameter(const std::string& id, float value);
  void loadPatch(const Juno106::JunoPatch& patch);
  void renderAudio(float* left, float* right, int numFrames);

 private:
  std::vector<std::unique_ptr<JunoVoice>> voices_;
  RCUParameterManager params_;
  int sampleRate_ = 44100;
  int bufferSize_ = 256;
  std::atomic<bool> running_{false};
};

