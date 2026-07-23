#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <numbers>
#include <span>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "audio_engine/instruments/juno/JunoDSPEngine.h"
#include "audio_engine/instruments/juno/detail/BBDChorus.h"

namespace daft::audio::tests {
namespace {

using juno::ChorusMode;
using juno::EngineConfig;
using juno::JunoDSPEngine;
using juno::ParameterId;
using juno::detail::BBDChorus;

static_assert(static_cast<std::uint16_t>(ParameterId::kPulseWidth) == 0x0001U);
static_assert(static_cast<std::uint16_t>(ParameterId::kSubLevel) == 0x0002U);
static_assert(static_cast<std::uint16_t>(ParameterId::kCutoffHz) == 0x0003U);
static_assert(static_cast<std::uint16_t>(ParameterId::kResonance) == 0x0004U);
static_assert(static_cast<std::uint16_t>(ParameterId::kAttackSeconds) == 0x0005U);
static_assert(static_cast<std::uint16_t>(ParameterId::kReleaseSeconds) == 0x0006U);
static_assert(static_cast<std::uint16_t>(ParameterId::kChorusMode) == 0x0007U);
static_assert(static_cast<std::uint16_t>(ParameterId::kOutputGain) == 0x0008U);
static_assert(static_cast<std::uint16_t>(ParameterId::kLfoRateHz) == 0x0009U);
static_assert(static_cast<std::uint16_t>(ParameterId::kLfoDepth) == 0x000aU);
static_assert(JunoDSPEngine::kDefaultOutputGain == 0.2F);
static_assert(JunoDSPEngine::kDefaultLfoRateHz == 0.8F);
static_assert(JunoDSPEngine::kDefaultLfoDepth == 0.0F);

struct StereoSamples {
  std::vector<float> left;
  std::vector<float> right;
};

struct AudioMetrics {
  double peak = 0.0;
  double rms = 0.0;
  double stereoDifferenceRms = 0.0;
};

struct SpectralBands {
  double low = 0.0;
  double mid = 0.0;
  double high = 0.0;
};

struct ReferenceAnalysis {
  AudioMetrics overall;
  double attackRms = 0.0;
  double sustainRms = 0.0;
  double releaseTailRms = 0.0;
  SpectralBands spectrum;
};

class OfflineRenderer final {
 public:
  OfflineRenderer(JunoDSPEngine& engine, std::size_t blockFrames)
      : engine_(engine), blockFrames_(blockFrames) {
    if (blockFrames_ == 0U) {
      throw std::runtime_error("OfflineRenderer requires a non-zero block size");
    }
  }

  [[nodiscard]] StereoSamples render(std::size_t frameCount) {
    StereoSamples rendered;
    rendered.left.resize(frameCount);
    rendered.right.resize(frameCount);
    std::size_t offset = 0;
    while (offset < frameCount) {
      const std::size_t frames = std::min(blockFrames_, frameCount - offset);
      engine_.render(std::span<float>(rendered.left).subspan(offset, frames),
                     std::span<float>(rendered.right).subspan(offset, frames));
      offset += frames;
    }
    return rendered;
  }

 private:
  JunoDSPEngine& engine_;
  std::size_t blockFrames_;
};

[[nodiscard]] std::size_t Frames(double seconds, double sampleRate) {
  return static_cast<std::size_t>(std::llround(seconds * sampleRate));
}

void Append(StereoSamples& destination, StereoSamples source) {
  destination.left.insert(destination.left.end(), source.left.begin(), source.left.end());
  destination.right.insert(destination.right.end(), source.right.begin(), source.right.end());
}

[[nodiscard]] AudioMetrics Measure(const StereoSamples& samples) {
  if (samples.left.size() != samples.right.size() || samples.left.empty()) {
    throw std::runtime_error("Metric input must be non-empty stereo audio");
  }

  long double sumSquares = 0.0L;
  long double stereoDifferenceSquares = 0.0L;
  double peak = 0.0;
  for (std::size_t frame = 0; frame < samples.left.size(); ++frame) {
    const double left = samples.left[frame];
    const double right = samples.right[frame];
    if (!std::isfinite(left) || !std::isfinite(right)) {
      throw std::runtime_error("Juno render produced a non-finite sample");
    }
    peak = std::max({peak, std::fabs(left), std::fabs(right)});
    sumSquares += left * left + right * right;
    const double difference = left - right;
    stereoDifferenceSquares += difference * difference;
  }

  const long double stereoSampleCount = static_cast<long double>(samples.left.size() * 2U);
  const long double frameCount = static_cast<long double>(samples.left.size());
  return AudioMetrics{
      peak,
      std::sqrt(static_cast<double>(sumSquares / stereoSampleCount)),
      std::sqrt(static_cast<double>(stereoDifferenceSquares / frameCount)),
  };
}

[[nodiscard]] double WindowRms(const StereoSamples& samples, std::size_t offset,
                               std::size_t frameCount) {
  if (samples.left.size() != samples.right.size() || frameCount == 0U ||
      offset > samples.left.size() || frameCount > samples.left.size() - offset) {
    throw std::runtime_error("Invalid RMS analysis window");
  }
  long double sumSquares = 0.0L;
  for (std::size_t frame = offset; frame < offset + frameCount; ++frame) {
    const double left = samples.left[frame];
    const double right = samples.right[frame];
    sumSquares += left * left + right * right;
  }
  return std::sqrt(static_cast<double>(sumSquares / static_cast<long double>(frameCount * 2U)));
}

[[nodiscard]] SpectralBands MeasureSpectrum(const StereoSamples& samples, std::size_t offset,
                                            std::size_t frameCount, double sampleRate) {
  if (samples.left.size() != samples.right.size() || frameCount < 2U ||
      offset > samples.left.size() || frameCount > samples.left.size() - offset) {
    throw std::runtime_error("Invalid spectral analysis window");
  }

  long double lowEnergy = 0.0L;
  long double midEnergy = 0.0L;
  long double highEnergy = 0.0L;
  const double denominator = static_cast<double>(frameCount - 1U);
  for (std::size_t bin = 1U; bin <= frameCount / 2U; ++bin) {
    long double real = 0.0L;
    long double imaginary = 0.0L;
    for (std::size_t frame = 0U; frame < frameCount; ++frame) {
      const double mono = (static_cast<double>(samples.left[offset + frame]) +
                           static_cast<double>(samples.right[offset + frame])) *
                          0.5;
      const double window =
          0.5 - 0.5 * std::cos(2.0 * std::numbers::pi * static_cast<double>(frame) / denominator);
      const double angle = -2.0 * std::numbers::pi * static_cast<double>(bin * frame) /
                           static_cast<double>(frameCount);
      real += mono * window * std::cos(angle);
      imaginary += mono * window * std::sin(angle);
    }
    const long double energy = real * real + imaginary * imaginary;
    const double frequency =
        static_cast<double>(bin) * sampleRate / static_cast<double>(frameCount);
    if (frequency < 250.0) {
      lowEnergy += energy;
    } else if (frequency < 2000.0) {
      midEnergy += energy;
    } else {
      highEnergy += energy;
    }
  }

  const long double totalEnergy = lowEnergy + midEnergy + highEnergy;
  if (totalEnergy <= std::numeric_limits<long double>::epsilon()) {
    throw std::runtime_error("Spectral analysis window contains no energy");
  }
  return SpectralBands{
      static_cast<double>(lowEnergy / totalEnergy),
      static_cast<double>(midEnergy / totalEnergy),
      static_cast<double>(highEnergy / totalEnergy),
  };
}

[[nodiscard]] ReferenceAnalysis AnalyzeReference(const StereoSamples& samples, double sampleRate,
                                                 double sustainOffsetSeconds,
                                                 double releaseTailOffsetSeconds,
                                                 double spectrumOffsetSeconds) {
  constexpr double kEnvelopeWindowSeconds = 0.05;
  constexpr std::size_t kSpectrumFrames = 1024U;
  return ReferenceAnalysis{
      Measure(samples),
      WindowRms(samples, 0U, Frames(kEnvelopeWindowSeconds, sampleRate)),
      WindowRms(samples, Frames(sustainOffsetSeconds, sampleRate),
                Frames(kEnvelopeWindowSeconds, sampleRate)),
      WindowRms(samples, Frames(releaseTailOffsetSeconds, sampleRate),
                Frames(kEnvelopeWindowSeconds, sampleRate)),
      MeasureSpectrum(samples, Frames(spectrumOffsetSeconds, sampleRate), kSpectrumFrames,
                      sampleRate),
  };
}

void AssertNear(double actual, double expected, double tolerance, const std::string& context) {
  if (!std::isfinite(actual) || !std::isfinite(expected) ||
      std::fabs(actual - expected) > tolerance) {
    throw std::runtime_error(context + " expected " + std::to_string(expected) + " got " +
                             std::to_string(actual));
  }
}

void AssertMetrics(const AudioMetrics& actual, const AudioMetrics& expected,
                   const std::string& context) {
  constexpr double kPeakTolerance = 0.002;
  constexpr double kEnergyTolerance = 0.001;
  AssertNear(actual.peak, expected.peak, kPeakTolerance, context + " peak");
  AssertNear(actual.rms, expected.rms, kEnergyTolerance, context + " RMS");
  AssertNear(actual.stereoDifferenceRms, expected.stereoDifferenceRms, kEnergyTolerance,
             context + " stereo difference RMS");
}

void AssertReferenceAnalysis(const ReferenceAnalysis& actual, const ReferenceAnalysis& expected,
                             const std::string& context) {
  AssertMetrics(actual.overall, expected.overall, context);
  constexpr double kEnvelopeTolerance = 0.001;
  constexpr double kSpectrumTolerance = 0.02;
  AssertNear(actual.attackRms, expected.attackRms, kEnvelopeTolerance, context + " attack RMS");
  AssertNear(actual.sustainRms, expected.sustainRms, kEnvelopeTolerance, context + " sustain RMS");
  AssertNear(actual.releaseTailRms, expected.releaseTailRms, kEnvelopeTolerance,
             context + " release-tail RMS");
  AssertNear(actual.spectrum.low, expected.spectrum.low, kSpectrumTolerance,
             context + " low-band energy");
  AssertNear(actual.spectrum.mid, expected.spectrum.mid, kSpectrumTolerance,
             context + " mid-band energy");
  AssertNear(actual.spectrum.high, expected.spectrum.high, kSpectrumTolerance,
             context + " high-band energy");
  const double spectralTotal = actual.spectrum.low + actual.spectrum.mid + actual.spectrum.high;
  AssertNear(spectralTotal, 1.0, 1.0e-9, context + " normalized spectral energy");
  if (actual.attackRms >= actual.sustainRms || actual.releaseTailRms >= actual.sustainRms) {
    throw std::runtime_error(context + " energy envelope is inconsistent");
  }
}

[[nodiscard]] double Correlation(const StereoSamples& first, const StereoSamples& second) {
  if (first.left.size() != second.left.size() || first.right.size() != second.right.size() ||
      first.left.size() != first.right.size() || first.left.empty()) {
    throw std::runtime_error("Correlation requires matching non-empty stereo buffers");
  }
  long double dotProduct = 0.0L;
  long double firstEnergy = 0.0L;
  long double secondEnergy = 0.0L;
  for (std::size_t frame = 0; frame < first.left.size(); ++frame) {
    for (const auto [firstSample, secondSample] :
         {std::pair{first.left[frame], second.left[frame]},
          std::pair{first.right[frame], second.right[frame]}}) {
      dotProduct += static_cast<long double>(firstSample) * secondSample;
      firstEnergy += static_cast<long double>(firstSample) * firstSample;
      secondEnergy += static_cast<long double>(secondSample) * secondSample;
    }
  }
  if (firstEnergy <= 0.0L || secondEnergy <= 0.0L) {
    throw std::runtime_error("Correlation input contains no signal energy");
  }
  return static_cast<double>(dotProduct / std::sqrt(firstEnergy * secondEnergy));
}

void AssertSilent(const StereoSamples& samples, const std::string& context) {
  const auto metrics = Measure(samples);
  if (metrics.peak != 0.0 || metrics.rms != 0.0 || metrics.stereoDifferenceRms != 0.0) {
    throw std::runtime_error(context + " expected exact silence");
  }
}

[[nodiscard]] StereoSamples RenderSingleNote(double sampleRate, std::size_t blockFrames) {
  JunoDSPEngine engine;
  if (!engine.prepare(EngineConfig{sampleRate, static_cast<std::uint32_t>(blockFrames), 6U}) ||
      !engine.setParameter(ParameterId::kOutputGain, 0.2F) || !engine.noteOn(60U, 0.8F)) {
    throw std::runtime_error("Unable to configure single-note Juno reference render");
  }

  OfflineRenderer renderer(engine, blockFrames);
  StereoSamples rendered = renderer.render(Frames(0.5, sampleRate));
  if (!engine.noteOff(60U)) {
    throw std::runtime_error("Single-note reference could not release its voice");
  }
  Append(rendered, renderer.render(Frames(1.0, sampleRate)));
  return rendered;
}

[[nodiscard]] StereoSamples RenderSixVoiceChord(double sampleRate, std::size_t blockFrames) {
  JunoDSPEngine engine;
  if (!engine.prepare(EngineConfig{sampleRate, static_cast<std::uint32_t>(blockFrames), 6U}) ||
      !engine.setParameter(ParameterId::kOutputGain, 0.2F)) {
    throw std::runtime_error("Unable to configure chord Juno reference render");
  }

  constexpr std::array<std::uint8_t, 6> kNotes = {48U, 55U, 60U, 64U, 67U, 72U};
  for (const auto note : kNotes) {
    if (!engine.noteOn(note, 0.65F)) {
      throw std::runtime_error("Unable to start a chord voice");
    }
  }
  if (engine.activeVoiceCount() != kNotes.size()) {
    throw std::runtime_error("Six-note chord did not occupy six voices");
  }

  OfflineRenderer renderer(engine, blockFrames);
  StereoSamples rendered = renderer.render(Frames(0.4, sampleRate));
  for (const auto note : kNotes) {
    if (!engine.noteOff(note)) {
      throw std::runtime_error("Unable to release a chord voice");
    }
  }
  Append(rendered, renderer.render(Frames(0.6, sampleRate)));
  return rendered;
}

void TestConfigurationAndSilence() {
  JunoDSPEngine engine;
  if (engine.isPrepared() || engine.noteOn(60U, 1.0F) || engine.noteOff(60U) ||
      engine.setParameter(ParameterId::kCutoffHz, 1200.0F)) {
    throw std::runtime_error("Unprepared Juno core accepted a realtime operation");
  }
  if (engine.prepare(EngineConfig{0.0, 256U, 6U}) ||
      engine.prepare(EngineConfig{-44100.0, 256U, 6U}) ||
      engine.prepare(EngineConfig{std::numeric_limits<double>::quiet_NaN(), 256U, 6U}) ||
      engine.prepare(EngineConfig{std::numeric_limits<double>::infinity(), 256U, 6U}) ||
      engine.prepare(EngineConfig{48000.0, 0U, 6U}) ||
      engine.prepare(EngineConfig{48000.0, JunoDSPEngine::kMaximumFramesPerBlock + 1U, 6U}) ||
      engine.prepare(EngineConfig{48000.0, 256U, 0U}) ||
      engine.prepare(EngineConfig{48000.0, 256U, JunoDSPEngine::kMaximumPolyphony + 1U})) {
    throw std::runtime_error("Juno core accepted an invalid configuration");
  }

  for (const double sampleRate : {44100.0, 48000.0}) {
    if (!engine.prepare(EngineConfig{sampleRate, 256U, 6U})) {
      throw std::runtime_error("Juno core rejected a supported sample rate");
    }
    if (!engine.isPrepared() || engine.sampleRate() != sampleRate || engine.polyphony() != 6U ||
        engine.maximumFramesPerBlock() != 256U) {
      throw std::runtime_error("Juno core did not retain its configuration");
    }
    constexpr std::array<int, 6> kInvalidNotes = {
        std::numeric_limits<int>::min(), -1, 128, 255, 256, std::numeric_limits<int>::max()};
    for (const int midiNote : kInvalidNotes) {
      if (engine.noteOn(midiNote, 0.5F) || engine.noteOff(midiNote)) {
        throw std::runtime_error("Juno core accepted an out-of-range MIDI note");
      }
    }
    if (engine.noteOn(60, std::numeric_limits<float>::quiet_NaN()) ||
        engine.noteOn(60, -0.1F) ||
        engine.setParameter(ParameterId::kCutoffHz, std::numeric_limits<float>::quiet_NaN()) ||
        engine.setParameter(ParameterId::kCutoffHz, std::numeric_limits<float>::infinity()) ||
        engine.setParameter(static_cast<ParameterId>(0x0000U), 1.0F) ||
        engine.setParameter(static_cast<ParameterId>(0xffffU), 1.0F)) {
      throw std::runtime_error("Juno core accepted an invalid note or parameter value");
    }
    if (!engine.noteOn(0, 0.5F) || !engine.noteOff(0) || !engine.noteOn(127, 0.5F) ||
        !engine.noteOff(127)) {
      throw std::runtime_error("Juno core rejected a boundary MIDI note");
    }
    engine.reset();
    OfflineRenderer renderer(engine, 256U);
    AssertSilent(renderer.render(4096U), "Prepared Juno core without notes");

    StereoSamples oversized{
        std::vector<float>(257U, 1.0F),
        std::vector<float>(257U, 1.0F),
    };
    engine.render(oversized.left, oversized.right);
    AssertSilent(oversized, "Oversized Juno render block");
  }
}

void TestReferenceRenders() {
  struct Reference {
    double sampleRate;
    ReferenceAnalysis single;
    ReferenceAnalysis chord;
  };
  constexpr std::array<Reference, 2> kReferences = {
      Reference{44100.0,
                {{0.163077, 0.065693, 0.056608},
                 0.073183,
                 0.101544,
                 0.014389,
                 {0.143127, 0.856872, 0.000001}},
                {{0.652604, 0.141230, 0.121684},
                 0.121735,
                 0.196068,
                 0.057850,
                 {0.459190, 0.540809, 0.000001}}},
      Reference{48000.0,
                {{0.163088, 0.065711, 0.056609},
                 0.073236,
                 0.101122,
                 0.014413,
                 {0.454950, 0.545049, 0.000001}},
                {{0.653051, 0.141268, 0.121714},
                 0.121775,
                 0.196186,
                 0.057926,
                 {0.476354, 0.523645, 0.000001}}},
  };
  const bool printReferences = std::getenv("DAFT_JUNO_PRINT_REFERENCES") != nullptr;

  for (const auto& reference : kReferences) {
    const double sampleRate = reference.sampleRate;
    const auto singleSamples = RenderSingleNote(sampleRate, 256U);
    const auto chordSamples = RenderSixVoiceChord(sampleRate, 256U);
    if (singleSamples.left.size() != Frames(1.5, sampleRate) ||
        chordSamples.left.size() != Frames(1.0, sampleRate)) {
      throw std::runtime_error("Reference renderer produced an unexpected frame count");
    }
    const auto single = AnalyzeReference(singleSamples, sampleRate, 0.35, 1.40, 0.25);
    const auto chord = AnalyzeReference(chordSamples, sampleRate, 0.25, 0.90, 0.20);
    if (printReferences) {
      std::cout << "JUNO_REFERENCE rate=" << sampleRate
                << " scenario=single peak=" << single.overall.peak << " rms=" << single.overall.rms
                << " stereo=" << single.overall.stereoDifferenceRms
                << " attack=" << single.attackRms << " sustain=" << single.sustainRms
                << " tail=" << single.releaseTailRms << " low=" << single.spectrum.low
                << " mid=" << single.spectrum.mid << " high=" << single.spectrum.high << '\n';
      std::cout << "JUNO_REFERENCE rate=" << sampleRate
                << " scenario=chord peak=" << chord.overall.peak << " rms=" << chord.overall.rms
                << " stereo=" << chord.overall.stereoDifferenceRms << " attack=" << chord.attackRms
                << " sustain=" << chord.sustainRms << " tail=" << chord.releaseTailRms
                << " low=" << chord.spectrum.low << " mid=" << chord.spectrum.mid
                << " high=" << chord.spectrum.high << '\n';
    } else {
      AssertReferenceAnalysis(single, reference.single,
                              "Single-note reference at " + std::to_string(sampleRate) + " Hz");
      AssertReferenceAnalysis(chord, reference.chord,
                              "Six-voice reference at " + std::to_string(sampleRate) + " Hz");
    }
  }
}

void TestBlockSizeIndependence() {
  for (const double sampleRate : {44100.0, 48000.0}) {
    const auto smallBlocks = RenderSingleNote(sampleRate, 64U);
    const auto largeBlocks = RenderSingleNote(sampleRate, 257U);
    if (smallBlocks.left.size() != largeBlocks.left.size() ||
        smallBlocks.right.size() != largeBlocks.right.size()) {
      throw std::runtime_error("Block-size comparison produced different frame counts");
    }
    if (Correlation(smallBlocks, largeBlocks) < 0.999999999) {
      throw std::runtime_error("Block-size render lost correlation with the reference");
    }
    for (std::size_t frame = 0; frame < smallBlocks.left.size(); ++frame) {
      AssertNear(smallBlocks.left[frame], largeBlocks.left[frame], 1.0e-7,
                 "Left output changed with block size");
      AssertNear(smallBlocks.right[frame], largeBlocks.right[frame], 1.0e-7,
                 "Right output changed with block size");
    }
  }
}

void TestSixVoiceLimitAndRelease() {
  for (const double sampleRate : {44100.0, 48000.0}) {
    JunoDSPEngine engine;
    if (!engine.prepare(EngineConfig{sampleRate, 128U, 6U}) ||
        !engine.setParameter(ParameterId::kReleaseSeconds, 0.05F)) {
      throw std::runtime_error("Unable to configure release test");
    }
    constexpr std::array<std::uint8_t, 7> kNotes = {48U, 52U, 55U, 60U, 64U, 67U, 72U};
    for (const auto note : kNotes) {
      if (!engine.noteOn(note, 0.7F)) {
        throw std::runtime_error("Voice-limit test rejected a valid note");
      }
    }
    if (engine.activeVoiceCount() != 6U) {
      throw std::runtime_error("Voice stealing exceeded six configured voices");
    }

    OfflineRenderer renderer(engine, 128U);
    const auto sounding = renderer.render(Frames(0.1, sampleRate));
    if (Measure(sounding).rms <= 0.001) {
      throw std::runtime_error("Voice-limit render did not produce audio");
    }
    engine.allNotesOff();
    const auto release = renderer.render(Frames(1.0, sampleRate));
    if (engine.activeVoiceCount() != 0U) {
      throw std::runtime_error("Released Juno voices remained active");
    }
    const std::size_t tailFrames = std::min<std::size_t>(1024U, release.left.size());
    StereoSamples tail{
        std::vector<float>(release.left.end() - static_cast<std::ptrdiff_t>(tailFrames),
                           release.left.end()),
        std::vector<float>(release.right.end() - static_cast<std::ptrdiff_t>(tailFrames),
                           release.right.end()),
    };
    AssertSilent(tail, "Juno release tail");

    engine.reset();
    AssertSilent(renderer.render(1024U), "Reset Juno core");
  }
}

void TestDefaultPolyphonicHeadroom() {
  constexpr std::array<int, 6> kNotes = {48, 55, 60, 64, 67, 72};
  for (const double sampleRate : {44100.0, 48000.0}) {
    JunoDSPEngine engine;
    if (!engine.prepare(EngineConfig{sampleRate, 256U, kNotes.size()})) {
      throw std::runtime_error("Unable to prepare default-headroom test");
    }
    for (const int note : kNotes) {
      if (!engine.noteOn(note, 0.65F)) {
        throw std::runtime_error("Default-headroom test rejected a chord note");
      }
    }

    OfflineRenderer renderer(engine, 256U);
    const auto metrics = Measure(renderer.render(Frames(0.4, sampleRate)));
    if (metrics.rms <= 0.001 || metrics.peak > 0.8) {
      throw std::runtime_error("Default six-voice gain does not provide bounded headroom");
    }
  }
}

void TestSingleGlobalChorusNoiseLayer() {
  constexpr std::array<int, 6> kNotes = {48, 55, 60, 64, 67, 72};
  for (const double sampleRate : {44100.0, 48000.0}) {
    JunoDSPEngine singleVoice;
    JunoDSPEngine sixVoices;
    if (!singleVoice.prepare(EngineConfig{sampleRate, 256U, 1U}) ||
        !sixVoices.prepare(EngineConfig{sampleRate, 256U, kNotes.size()}) ||
        !singleVoice.noteOn(60, 1.0e-12F)) {
      throw std::runtime_error("Unable to configure global chorus noise test");
    }
    for (const int note : kNotes) {
      if (!sixVoices.noteOn(note, 1.0e-12F)) {
        throw std::runtime_error("Global chorus noise test rejected a chord note");
      }
    }

    OfflineRenderer singleRenderer(singleVoice, 256U);
    OfflineRenderer sixRenderer(sixVoices, 256U);
    const auto singleNoise = singleRenderer.render(Frames(0.1, sampleRate));
    const auto sixVoiceNoise = sixRenderer.render(Frames(0.1, sampleRate));
    const auto singleMetrics = Measure(singleNoise);
    const auto sixVoiceMetrics = Measure(sixVoiceNoise);
    if (singleMetrics.rms <= 1.0e-6 || sixVoiceMetrics.rms <= 1.0e-6 ||
        sixVoiceMetrics.rms / singleMetrics.rms < 0.99 ||
        sixVoiceMetrics.rms / singleMetrics.rms > 1.01 ||
        Correlation(singleNoise, sixVoiceNoise) < 0.999999) {
      throw std::runtime_error("Chorus noise was not produced by one global effect layer");
    }
  }
}

void TestChorusModeRoutingAndBypassHistory() {
  for (const double sampleRate : {44100.0, 48000.0}) {
    JunoDSPEngine engine;
    if (!engine.prepare(EngineConfig{sampleRate, 256U, 1U}) ||
        !engine.setParameter(ParameterId::kChorusMode,
                             static_cast<float>(ChorusMode::kOff)) ||
        !engine.noteOn(60, 0.8F)) {
      throw std::runtime_error("Unable to configure chorus routing test");
    }
    OfflineRenderer renderer(engine, 256U);
    const auto bypassed = Measure(renderer.render(Frames(0.1, sampleRate)));
    if (bypassed.stereoDifferenceRms != 0.0) {
      throw std::runtime_error("Chorus bypass did not produce dual-mono output");
    }
    if (!engine.setParameter(ParameterId::kChorusMode,
                             static_cast<float>(ChorusMode::kI))) {
      throw std::runtime_error("Unable to enable the engine-level chorus");
    }
    const auto enabled = Measure(renderer.render(Frames(0.1, sampleRate)));
    if (enabled.stereoDifferenceRms <= 1.0e-5) {
      throw std::runtime_error("Engine-level chorus did not restore stereo modulation");
    }

    BBDChorus impulseChorus;
    BBDChorus controlChorus;
    impulseChorus.prepare(static_cast<float>(sampleRate));
    controlChorus.prepare(static_cast<float>(sampleRate));
    impulseChorus.setMode(ChorusMode::kI);
    controlChorus.setMode(ChorusMode::kI);
    float impulseLeft = 0.0F;
    float impulseRight = 0.0F;
    float controlLeft = 0.0F;
    float controlRight = 0.0F;
    impulseChorus.process(1.0F, impulseLeft, impulseRight);
    controlChorus.process(0.0F, controlLeft, controlRight);
    impulseChorus.setMode(ChorusMode::kOff);
    controlChorus.setMode(ChorusMode::kOff);
    const auto flushFrames = Frames(0.051, sampleRate) + 8U;
    for (std::size_t frame = 0; frame < flushFrames; ++frame) {
      impulseChorus.process(0.0F, impulseLeft, impulseRight);
      controlChorus.process(0.0F, controlLeft, controlRight);
    }
    impulseChorus.setMode(ChorusMode::kI);
    controlChorus.setMode(ChorusMode::kI);
    for (std::size_t frame = 0; frame < Frames(0.04, sampleRate); ++frame) {
      impulseChorus.process(0.0F, impulseLeft, impulseRight);
      controlChorus.process(0.0F, controlLeft, controlRight);
      AssertNear(impulseLeft, controlLeft, 1.0e-7, "Left chorus bypass history");
      AssertNear(impulseRight, controlRight, 1.0e-7, "Right chorus bypass history");
    }
  }
}

void TestChorusTailDrainAndOutputGain() {
  for (const double sampleRate : {44100.0, 48000.0}) {
    JunoDSPEngine unityGain;
    JunoDSPEngine halfGain;
    JunoDSPEngine noiseOnly;
    const EngineConfig config{sampleRate, 256U, 1U};
    if (!unityGain.prepare(config) || !halfGain.prepare(config) || !noiseOnly.prepare(config) ||
        !unityGain.setParameter(ParameterId::kReleaseSeconds, 0.0005F) ||
        !halfGain.setParameter(ParameterId::kReleaseSeconds, 0.0005F) ||
        !noiseOnly.setParameter(ParameterId::kReleaseSeconds, 0.0005F) ||
        !unityGain.setParameter(ParameterId::kChorusMode,
                                static_cast<float>(ChorusMode::kII)) ||
        !halfGain.setParameter(ParameterId::kChorusMode,
                               static_cast<float>(ChorusMode::kII)) ||
        !noiseOnly.setParameter(ParameterId::kChorusMode,
                                static_cast<float>(ChorusMode::kII)) ||
        !unityGain.setParameter(ParameterId::kOutputGain, 1.0F) ||
        !halfGain.setParameter(ParameterId::kOutputGain, 0.5F) ||
        !noiseOnly.setParameter(ParameterId::kOutputGain, 1.0F) ||
        !unityGain.noteOn(60, 0.8F) || !halfGain.noteOn(60, 0.8F) ||
        !noiseOnly.noteOn(60, 1.0e-12F)) {
      throw std::runtime_error("Unable to configure chorus-tail drain test");
    }

    OfflineRenderer unityRenderer(unityGain, 256U);
    OfflineRenderer halfRenderer(halfGain, 256U);
    OfflineRenderer noiseRenderer(noiseOnly, 256U);
    (void)unityRenderer.render(Frames(0.05, sampleRate));
    (void)halfRenderer.render(Frames(0.05, sampleRate));
    (void)noiseRenderer.render(Frames(0.05, sampleRate));
    if (!unityGain.noteOff(60) || !halfGain.noteOff(60) || !noiseOnly.noteOff(60)) {
      throw std::runtime_error("Unable to release chorus-tail test voices");
    }

    std::array<float, 1> unityLeft{};
    std::array<float, 1> unityRight{};
    std::array<float, 1> halfLeft{};
    std::array<float, 1> halfRight{};
    std::array<float, 1> noiseLeft{};
    std::array<float, 1> noiseRight{};
    const std::size_t releaseLimit = Frames(0.1, sampleRate);
    std::size_t releaseFrame = 0U;
    while (unityGain.activeVoiceCount() > 0U && releaseFrame < releaseLimit) {
      unityGain.render(unityLeft, unityRight);
      halfGain.render(halfLeft, halfRight);
      noiseOnly.render(noiseLeft, noiseRight);
      if (unityGain.activeVoiceCount() != halfGain.activeVoiceCount() ||
          unityGain.activeVoiceCount() != noiseOnly.activeVoiceCount()) {
        throw std::runtime_error("Chorus-tail control voice lifetimes diverged");
      }
      ++releaseFrame;
    }
    if (unityGain.activeVoiceCount() != 0U || halfGain.activeVoiceCount() != 0U ||
        noiseOnly.activeVoiceCount() != 0U) {
      throw std::runtime_error("Chorus-tail test voice did not finish releasing");
    }

    const auto unityTail = unityRenderer.render(Frames(0.01, sampleRate));
    const auto halfTail = halfRenderer.render(Frames(0.01, sampleRate));
    const auto noiseTail = noiseRenderer.render(Frames(0.01, sampleRate));
    bool containsDelayedSignal = false;
    for (std::size_t frame = 0; frame < unityTail.left.size(); ++frame) {
      AssertNear(halfTail.left[frame], unityTail.left[frame] * 0.5, 1.0e-7,
                 "Left chorus-tail output gain");
      AssertNear(halfTail.right[frame], unityTail.right[frame] * 0.5, 1.0e-7,
                 "Right chorus-tail output gain");
      containsDelayedSignal =
          std::fabs(unityTail.left[frame] - noiseTail.left[frame]) > 1.0e-4 ||
          std::fabs(unityTail.right[frame] - noiseTail.right[frame]) > 1.0e-4 ||
          containsDelayedSignal;
    }
    if (!containsDelayedSignal) {
      throw std::runtime_error("Chorus history was truncated with the final active voice");
    }

    (void)unityRenderer.render(Frames(0.06, sampleRate));
    (void)halfRenderer.render(Frames(0.06, sampleRate));
    (void)noiseRenderer.render(Frames(0.06, sampleRate));
    AssertSilent(unityRenderer.render(128U), "Drained unity-gain chorus tail");
    AssertSilent(halfRenderer.render(128U), "Drained half-gain chorus tail");
    AssertSilent(noiseRenderer.render(128U), "Drained noise-only chorus tail");
  }
}

void TestOverlappingSameNoteGates() {
  for (const double sampleRate : {44100.0, 48000.0}) {
    JunoDSPEngine engine;
    if (!engine.prepare(EngineConfig{sampleRate, 128U, 6U}) ||
        !engine.setParameter(ParameterId::kReleaseSeconds, 0.05F) ||
        !engine.noteOn(60, 0.8F) || !engine.noteOn(60, 0.7F)) {
      throw std::runtime_error("Unable to configure overlapping-note gate test");
    }
    if (engine.activeVoiceCount() != 1U) {
      throw std::runtime_error("Overlapping same-note gates allocated duplicate voices");
    }

    OfflineRenderer renderer(engine, 128U);
    (void)renderer.render(Frames(0.05, sampleRate));
    if (!engine.noteOff(60)) {
      throw std::runtime_error("First overlapping note-off was rejected");
    }
    const auto stillHeld = renderer.render(Frames(0.2, sampleRate));
    if (engine.activeVoiceCount() != 1U || Measure(stillHeld).rms <= 0.001) {
      throw std::runtime_error("First note-off released a still-held overlapping note");
    }

    if (!engine.noteOff(60)) {
      throw std::runtime_error("Second overlapping note-off was rejected");
    }
    const auto released = renderer.render(Frames(1.0, sampleRate));
    if (engine.activeVoiceCount() != 0U || engine.noteOff(60)) {
      throw std::runtime_error("Overlapping note gates did not balance after the second note-off");
    }
    const std::size_t tailFrames = std::min<std::size_t>(1024U, released.left.size());
    StereoSamples tail{
        std::vector<float>(released.left.end() - static_cast<std::ptrdiff_t>(tailFrames),
                           released.left.end()),
        std::vector<float>(released.right.end() - static_cast<std::ptrdiff_t>(tailFrames),
                           released.right.end()),
    };
    AssertSilent(tail, "Overlapping same-note release tail");
  }
}

void TestGateCounterLifecycleAndVoiceStealing() {
  for (const double sampleRate : {44100.0, 48000.0}) {
    JunoDSPEngine engine;
    const EngineConfig config{sampleRate, 128U, 1U};
    if (!engine.prepare(config) || !engine.noteOn(60, 0.8F) || !engine.noteOn(60, 0.7F)) {
      throw std::runtime_error("Unable to configure gate lifecycle test");
    }
    engine.allNotesOff();
    if (engine.noteOff(60)) {
      throw std::runtime_error("allNotesOff left a held-note count behind");
    }

    if (!engine.noteOn(60, 0.8F) || !engine.noteOn(60, 0.7F)) {
      throw std::runtime_error("Unable to configure reset gate lifecycle test");
    }
    engine.reset();
    if (engine.noteOff(60)) {
      throw std::runtime_error("reset left a held-note count behind");
    }

    if (!engine.noteOn(60, 0.8F) || !engine.noteOn(60, 0.7F) || !engine.prepare(config) ||
        engine.noteOff(60)) {
      throw std::runtime_error("prepare did not replace held-note state");
    }

    if (!engine.noteOn(60, 0.8F) || !engine.noteOn(62, 0.8F) || !engine.noteOff(60)) {
      throw std::runtime_error("Voice-stealing gate setup failed");
    }
    OfflineRenderer renderer(engine, 128U);
    const auto stolenNoteReleased = renderer.render(Frames(0.2, sampleRate));
    if (engine.activeVoiceCount() != 1U || Measure(stolenNoteReleased).rms <= 0.001) {
      throw std::runtime_error("A stolen note-off released the replacement voice");
    }
    if (!engine.noteOff(62)) {
      throw std::runtime_error("Replacement voice note-off was rejected");
    }
  }
}

void TestOldestActiveVoiceStealing() {
  for (const double sampleRate : {44100.0, 48000.0}) {
    JunoDSPEngine engine;
    if (!engine.prepare(EngineConfig{sampleRate, 128U, 2U}) ||
        !engine.setParameter(ParameterId::kReleaseSeconds, 0.0005F) ||
        !engine.noteOn(60, 0.8F) || !engine.noteOn(62, 0.8F) ||
        !engine.noteOn(60, 0.7F) || !engine.noteOn(64, 0.8F) ||
        !engine.noteOff(62)) {
      throw std::runtime_error("Unable to configure oldest-voice stealing test");
    }

    OfflineRenderer renderer(engine, 128U);
    (void)renderer.render(Frames(0.02, sampleRate));
    if (engine.activeVoiceCount() != 2U) {
      throw std::runtime_error("Voice stealing did not preserve the newer retriggered voice");
    }
  }
}

void TestRetriggeredNoteRelease() {
  for (const double sampleRate : {44100.0, 48000.0}) {
    JunoDSPEngine engine;
    if (!engine.prepare(EngineConfig{sampleRate, 128U, 6U}) ||
        !engine.setParameter(ParameterId::kReleaseSeconds, 0.1F) ||
        !engine.noteOn(60U, 0.8F)) {
      throw std::runtime_error("Unable to configure same-note retrigger test");
    }

    OfflineRenderer renderer(engine, 128U);
    (void)renderer.render(Frames(0.05, sampleRate));
    if (!engine.noteOff(60U)) {
      throw std::runtime_error("Same-note retrigger test could not begin release");
    }
    (void)renderer.render(Frames(0.02, sampleRate));
    if (engine.activeVoiceCount() != 1U) {
      throw std::runtime_error("Release tail ended before same-note retrigger");
    }
    if (!engine.noteOn(60U, 0.7F)) {
      throw std::runtime_error("Unable to retrigger a releasing voice");
    }
    if (engine.activeVoiceCount() != 1U) {
      throw std::runtime_error("Same-note retrigger allocated a duplicate voice");
    }

    (void)renderer.render(Frames(0.05, sampleRate));
    if (!engine.noteOff(60U)) {
      throw std::runtime_error("Same-note retrigger could not be released");
    }
    const auto released = renderer.render(Frames(1.0, sampleRate));
    if (engine.activeVoiceCount() != 0U) {
      throw std::runtime_error("Same-note retrigger left a sustaining voice active");
    }

    const std::size_t tailFrames = std::min<std::size_t>(1024U, released.left.size());
    StereoSamples tail{
        std::vector<float>(released.left.end() - static_cast<std::ptrdiff_t>(tailFrames),
                           released.left.end()),
        std::vector<float>(released.right.end() - static_cast<std::ptrdiff_t>(tailFrames),
                           released.right.end()),
    };
    AssertSilent(tail, "Same-note retrigger release tail");
  }
}

[[nodiscard]] StereoSamples RenderLfoScenario(float rateHz, float depth,
                                              float pitchBend = 0.0F) {
  JunoDSPEngine engine;
  if (!engine.prepare(EngineConfig{48000.0, 256U, 1U}) ||
      !engine.setParameter(ParameterId::kChorusMode,
                           static_cast<float>(ChorusMode::kOff)) ||
      !engine.setParameter(ParameterId::kOutputGain, 1.0F) ||
      !engine.setParameter(ParameterId::kAttackSeconds, 0.0005F) ||
      !engine.setParameter(ParameterId::kLfoRateHz, rateHz) ||
      !engine.setParameter(ParameterId::kLfoDepth, depth) ||
      !engine.setPitchBend(0U, pitchBend) || !engine.noteOn(0U, 60, 0.8F)) {
    throw std::runtime_error("Unable to configure LFO render scenario");
  }
  return OfflineRenderer(engine, 256U).render(12000U);
}

void AssertSamplesEqual(const StereoSamples& actual, const StereoSamples& expected,
                        const std::string& context) {
  if (actual.left.size() != expected.left.size() ||
      actual.right.size() != expected.right.size()) {
    throw std::runtime_error(context + " frame count differs");
  }
  for (std::size_t frame = 0U; frame < actual.left.size(); ++frame) {
    AssertNear(actual.left[frame], expected.left[frame], 0.0, context + " left");
    AssertNear(actual.right[frame], expected.right[frame], 0.0, context + " right");
  }
}

void TestGlobalLfoPitchModulation() {
  const auto zeroDepthSlow =
      RenderLfoScenario(JunoDSPEngine::kMinimumLfoRateHz, 0.0F);
  const auto zeroDepthFast =
      RenderLfoScenario(JunoDSPEngine::kMaximumLfoRateHz, 0.0F);
  AssertSamplesEqual(zeroDepthFast, zeroDepthSlow,
                     "Zero-depth LFO changed the dry oscillator");

  const auto modulated = RenderLfoScenario(8.0F, 1.0F);
  bool changed = false;
  for (std::size_t frame = 0U; frame < modulated.left.size(); ++frame) {
    if (std::fabs(modulated.left[frame] - zeroDepthSlow.left[frame]) > 1.0e-5F) {
      changed = true;
      break;
    }
  }
  if (!changed) {
    throw std::runtime_error("Non-zero LFO depth did not modulate oscillator pitch");
  }

  const auto combinedBend = RenderLfoScenario(8.0F, 1.0F, 1.0F);
  if (!std::all_of(combinedBend.left.begin(), combinedBend.left.end(),
                   [](float sample) { return std::isfinite(sample); })) {
    throw std::runtime_error("Combined pitch bend and LFO produced non-finite output");
  }
}

void TestLfoBoundsAndResetPersistence() {
  const auto clampedMinimumRate = RenderLfoScenario(-100.0F, 1.0F);
  const auto explicitMinimumRate =
      RenderLfoScenario(JunoDSPEngine::kMinimumLfoRateHz, 1.0F);
  AssertSamplesEqual(clampedMinimumRate, explicitMinimumRate,
                     "LFO minimum-rate clamp");

  const auto clampedMaximumRate = RenderLfoScenario(100.0F, 0.5F);
  const auto explicitMaximumRate =
      RenderLfoScenario(JunoDSPEngine::kMaximumLfoRateHz, 0.5F);
  AssertSamplesEqual(clampedMaximumRate, explicitMaximumRate,
                     "LFO maximum-rate clamp");

  const auto clampedMaximumDepth = RenderLfoScenario(5.0F, 100.0F);
  const auto explicitMaximumDepth =
      RenderLfoScenario(5.0F, JunoDSPEngine::kMaximumLfoDepth);
  AssertSamplesEqual(clampedMaximumDepth, explicitMaximumDepth,
                     "LFO maximum-depth clamp");

  const auto clampedMinimumDepth = RenderLfoScenario(5.0F, -100.0F);
  const auto explicitMinimumDepth =
      RenderLfoScenario(5.0F, JunoDSPEngine::kMinimumLfoDepth);
  AssertSamplesEqual(clampedMinimumDepth, explicitMinimumDepth,
                     "LFO minimum-depth clamp");

  JunoDSPEngine engine;
  if (!engine.prepare(EngineConfig{48000.0, 256U, 1U}) ||
      !engine.setParameter(ParameterId::kChorusMode,
                           static_cast<float>(ChorusMode::kOff)) ||
      !engine.setParameter(ParameterId::kLfoRateHz, 6.0F) ||
      !engine.setParameter(ParameterId::kLfoDepth, 0.75F) ||
      !engine.noteOn(60, 0.8F)) {
    throw std::runtime_error("Unable to configure LFO reset persistence test");
  }
  OfflineRenderer renderer(engine, 256U);
  const auto beforeReset = renderer.render(4096U);
  engine.reset();
  if (!engine.noteOn(60, 0.8F)) {
    throw std::runtime_error("LFO reset persistence rejected its second note");
  }
  const auto afterReset = renderer.render(4096U);
  AssertSamplesEqual(afterReset, beforeReset,
                     "LFO parameters or deterministic phase changed across reset");
}

}  // namespace

void RunJunoCoreTests() {
  TestConfigurationAndSilence();
  TestReferenceRenders();
  TestBlockSizeIndependence();
  TestSixVoiceLimitAndRelease();
  TestDefaultPolyphonicHeadroom();
  TestSingleGlobalChorusNoiseLayer();
  TestChorusModeRoutingAndBypassHistory();
  TestChorusTailDrainAndOutputGain();
  TestOverlappingSameNoteGates();
  TestGateCounterLifecycleAndVoiceStealing();
  TestOldestActiveVoiceStealing();
  TestRetriggeredNoteRelease();
  TestGlobalLfoPitchModulation();
  TestLfoBoundsAndResetPersistence();
}

}  // namespace daft::audio::tests
