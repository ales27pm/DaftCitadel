#pragma once

#include "audio_engine/instruments/juno/BBDChorus.hpp"
#include "audio_engine/instruments/juno/NonlinearVCF.hpp"

#include <cmath>
#include <string>

class JunoVoice {
 public:
  void initialize(float sampleRate);
  void noteOn(int midiNote, float velocity);
  void noteOff(int midiNote);
  void advanceState(int numFrames);
  void setParam(const std::string& id, float value);
  void process(float& left, float& right);
  bool isActive() const;

  float frequency_ = 0.0f;
  float velocity_ = 0.0f;
  float envelopeLevel() const { return envelopeLevel_; }
  float phase() const { return phase_; }
  float pulseWidth() const { return pwmDepth_; }

 private:
  float sampleRate_ = 44100.0f;
  float phase_ = 0.0f;
  float envelopeLevel_ = 0.0f;
  float envelopeTarget_ = 0.0f;
  bool active_ = false;
  int midiNote_ = -1;

  float attack_ = 0.01f;
  float release_ = 0.5f;
  float cutoff_ = 1000.0f;
  float resonance_ = 0.1f;
  float subLevel_ = 0.0f;
  float pwmDepth_ = 0.5f;
  float subPhase_ = 0.0f;

  NonlinearVCF filter_;
  BBDChorus chorus_;
  bool stepEnvelopeAndPhase();
};

