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

namespace daft::audio::tests {
namespace {

using juno::EngineConfig;
using juno::JunoDSPEngine;
using juno::ParameterId;

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
    if (engine.noteOn(255U, 0.5F) || engine.noteOn(60U, std::numeric_limits<float>::quiet_NaN()) ||
        engine.noteOn(60U, -0.1F) ||
        engine.setParameter(ParameterId::kCutoffHz, std::numeric_limits<float>::quiet_NaN()) ||
        engine.setParameter(ParameterId::kCutoffHz, std::numeric_limits<float>::infinity())) {
      throw std::runtime_error("Juno core accepted an invalid note or parameter value");
    }
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
                {{0.163031, 0.065622, 0.056528},
                 0.079276,
                 0.101545,
                 0.014207,
                 {0.143135, 0.856864, 0.000001}},
                {{0.652110, 0.140816, 0.121322},
                 0.128262,
                 0.196081,
                 0.057354,
                 {0.459108, 0.540886, 0.000006}}},
      Reference{48000.0,
                {{0.163036, 0.065639, 0.056526},
                 0.079329,
                 0.101122,
                 0.014236,
                 {0.454942, 0.545057, 0.000001}},
                {{0.653647, 0.140854, 0.121347},
                 0.128305,
                 0.196179,
                 0.057429,
                 {0.476394, 0.523599, 0.000007}}},
  };

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
    if (std::getenv("DAFT_JUNO_PRINT_REFERENCES") != nullptr) {
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
    }
    AssertReferenceAnalysis(single, reference.single,
                            "Single-note reference at " + std::to_string(sampleRate) + " Hz");
    AssertReferenceAnalysis(chord, reference.chord,
                            "Six-voice reference at " + std::to_string(sampleRate) + " Hz");
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

}  // namespace

void RunJunoCoreTests() {
  TestConfigurationAndSilence();
  TestReferenceRenders();
  TestBlockSizeIndependence();
  TestSixVoiceLimitAndRelease();
}

}  // namespace daft::audio::tests
