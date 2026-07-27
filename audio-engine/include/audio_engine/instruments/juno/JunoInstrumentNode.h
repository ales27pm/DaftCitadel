#pragma once

#include "audio_engine/DSPNode.h"
#include "audio_engine/instruments/juno/JunoDSPEngine.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <string>

namespace daft::audio {

class JunoInstrumentNode final : public DSPNode {
 public:
  explicit JunoInstrumentNode(std::size_t polyphony = 8);

  void prepare(double sampleRate) override;
  void reset() noexcept override;
  void process(AudioBufferView buffer) noexcept override;
  void setParameter(const std::string& name, double value) override;

 private:
  static std::string normalizeParameter(std::string value);
  static bool toInt(double value, int& out);
  static bool toUnsigned(double value, std::size_t& out, std::size_t minValue, std::size_t maxValue);

  void ensureInitialized();
  void applyPatchParameter(const std::string& name, double value);

  juno::JunoDSPEngine engine_;
  std::size_t polyphony_;
  float noteVelocity_{1.0f};
  bool initialized_{false};
  bool started_{false};
  double sampleRate_{44100.0};
  mutable std::vector<float> rightScratch_;
};

}  // namespace daft::audio
