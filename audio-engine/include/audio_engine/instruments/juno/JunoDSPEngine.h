#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <span>

namespace daft::audio::juno {

// Numeric identifiers keep parameter dispatch independent from strings and
// make this core safe to drive from a bounded realtime command queue later.
enum class ParameterId : std::uint16_t {
  kPulseWidth,
  kSubLevel,
  kCutoffHz,
  kResonance,
  kAttackSeconds,
  kReleaseSeconds,
  kChorusMode,
  kOutputGain,
};

enum class ChorusMode : std::uint8_t {
  kOff = 0,
  kI = 1,
  kII = 2,
};

struct EngineConfig {
  double sampleRate = 48000.0;
  std::uint32_t maximumFramesPerBlock = 256;
  std::size_t polyphony = 6;
};

// Portable CPU-only Juno synthesis core. Allocation is confined to prepare();
// render(), note handling, reset(), and parameter updates do not allocate,
// lock, perform I/O, log, or call platform/JavaScript APIs.
//
// PR 1 intentionally exposes a single-threaded offline control surface. Callers
// must serialize render and control calls until the bounded MIDI/parameter
// queues land in the realtime foundation phase.
class JunoDSPEngine final {
 public:
  static constexpr std::size_t kDefaultPolyphony = 6;
  static constexpr std::size_t kMaximumPolyphony = 64;
  static constexpr std::uint32_t kMaximumFramesPerBlock = 65536;

  JunoDSPEngine();
  ~JunoDSPEngine();

  JunoDSPEngine(const JunoDSPEngine&) = delete;
  JunoDSPEngine& operator=(const JunoDSPEngine&) = delete;
  JunoDSPEngine(JunoDSPEngine&&) = delete;
  JunoDSPEngine& operator=(JunoDSPEngine&&) = delete;

  [[nodiscard]] bool prepare(const EngineConfig& config);
  void reset() noexcept;

  [[nodiscard]] bool noteOn(std::uint8_t midiNote, float velocity) noexcept;
  [[nodiscard]] bool noteOff(std::uint8_t midiNote) noexcept;
  void allNotesOff() noexcept;
  [[nodiscard]] bool setParameter(ParameterId parameter, float value) noexcept;

  void render(std::span<float> left, std::span<float> right) noexcept;

  [[nodiscard]] bool isPrepared() const noexcept;
  [[nodiscard]] double sampleRate() const noexcept;
  [[nodiscard]] std::uint32_t maximumFramesPerBlock() const noexcept;
  [[nodiscard]] std::size_t polyphony() const noexcept;
  [[nodiscard]] std::size_t activeVoiceCount() const noexcept;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace daft::audio::juno
