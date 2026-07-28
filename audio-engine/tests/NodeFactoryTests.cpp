#include "../platform/common/NodeFactory.h"

#include <cmath>
#include <limits>
#include <stdexcept>
#include <string>

namespace daft::audio::tests {
namespace {

void RequireNodeFactory(bool condition, const std::string& message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

void TestStringOptionConversionDoesNotUseExceptionControlFlow() {
  bridge::NodeOptions options;
  bridge::detail::storeStringOption(options, "label", "Juno-106");
  bridge::detail::storeStringOption(options, "ioid", "input:midi");
  bridge::detail::storeStringOption(options, "cutoffhz", "2400.5");
  bridge::detail::storeStringOption(options, "enabled", "yes");
  bridge::detail::storeStringOption(options, "armed", "ON");
  bridge::detail::storeStringOption(options, "visible", "true");
  bridge::detail::storeStringOption(options, "disabled", "off");
  bridge::detail::storeStringOption(options, "bypassed", "no");
  bridge::detail::storeStringOption(options, "hidden", "False");
  bridge::detail::storeStringOption(options, "units", "12 dB");
  bridge::detail::storeStringOption(options, "overflow", "1e9999");
  bridge::detail::storeStringOption(options, "notanumber", "nan");
  bridge::detail::storeStringOption(options, "infinity", "inf");

  RequireNodeFactory(options.stringValue("label") == "Juno-106",
                     "Label metadata was not preserved as a string");
  RequireNodeFactory(!options.numericValue("label").has_value(),
                     "Label metadata was incorrectly coerced to a number");
  RequireNodeFactory(options.stringValue("ioid") == "input:midi",
                     "I/O metadata was not preserved as a string");
  RequireNodeFactory(!options.numericValue("ioid").has_value(),
                     "I/O metadata was incorrectly coerced to a number");

  const auto cutoff = options.numericValue("cutoffhz");
  RequireNodeFactory(cutoff.has_value() &&
                         std::fabs(*cutoff - 2400.5) <
                             std::numeric_limits<double>::epsilon(),
                     "Numeric string option was not converted");
  RequireNodeFactory(options.stringValue("cutoffhz") == "2400.5",
                     "Numeric string option was not preserved as a string");
  RequireNodeFactory(options.numericValue("enabled") == 1.0 &&
                         options.numericValue("armed") == 1.0 &&
                         options.numericValue("visible") == 1.0,
                     "True-like string options were not converted");
  RequireNodeFactory(options.numericValue("disabled") == 0.0 &&
                         options.numericValue("bypassed") == 0.0 &&
                         options.numericValue("hidden") == 0.0,
                     "False-like string options were not converted");
  RequireNodeFactory(!options.numericValue("units").has_value(),
                     "Partially numeric metadata was incorrectly converted");
  RequireNodeFactory(!options.numericValue("overflow").has_value(),
                     "Out-of-range numeric metadata was incorrectly converted");
  RequireNodeFactory(!options.numericValue("notanumber").has_value() &&
                         !options.numericValue("infinity").has_value(),
                     "Non-finite numeric metadata was incorrectly converted");
}

void TestProductionJunoGraphMetadataConversion() {
  bridge::NodeOptions inputOptions;
  inputOptions.setNumeric("gain", 1.0);
  inputOptions.setNumeric("channelcount", 2.0);
  bridge::detail::storeStringOption(inputOptions, "ioid", "input:midi");
  bridge::detail::storeStringOption(inputOptions, "label", "Track Input");

  bridge::NodeOptions junoOptions;
  junoOptions.setNumeric("pulsewidth", 0.5);
  junoOptions.setNumeric("sublevel", 0.35);
  junoOptions.setNumeric("cutoffhz", 2400.0);
  junoOptions.setNumeric("resonance", 0.15);
  junoOptions.setNumeric("attackseconds", 0.01);
  junoOptions.setNumeric("releaseseconds", 0.45);
  junoOptions.setNumeric("chorusmode", 1.0);
  junoOptions.setNumeric("outputgain", 0.2);
  junoOptions.setNumeric("lforatehz", 0.8);
  junoOptions.setNumeric("lfodepth", 0.0);
  junoOptions.setNumeric("polyphony", 8.0);
  bridge::detail::storeStringOption(junoOptions, "label", "Juno-106");

  bridge::NodeOptions outputOptions;
  outputOptions.setNumeric("gain", 1.0);
  outputOptions.setNumeric("channelcount", 2.0);
  bridge::detail::storeStringOption(outputOptions, "ioid", "output:main");
  bridge::detail::storeStringOption(outputOptions, "label", "Track Output");

  RequireNodeFactory(inputOptions.numericValue("gain") == 1.0 &&
                         inputOptions.stringValue("ioid") == "input:midi" &&
                         !inputOptions.numericValue("ioid").has_value() &&
                         inputOptions.stringValue("label") == "Track Input" &&
                         !inputOptions.numericValue("label").has_value(),
                     "Production input metadata conversion failed");
  RequireNodeFactory(junoOptions.numericValue("polyphony") == 8.0 &&
                         junoOptions.stringValue("label") == "Juno-106" &&
                         !junoOptions.numericValue("label").has_value(),
                     "Production Juno metadata conversion failed");
  RequireNodeFactory(outputOptions.numericValue("gain") == 1.0 &&
                         outputOptions.stringValue("ioid") == "output:main" &&
                         !outputOptions.numericValue("ioid").has_value() &&
                         outputOptions.stringValue("label") == "Track Output" &&
                         !outputOptions.numericValue("label").has_value(),
                     "Production output metadata conversion failed");
}

}  // namespace

void RunNodeFactoryTests() {
  TestStringOptionConversionDoesNotUseExceptionControlFlow();
  TestProductionJunoGraphMetadataConversion();
}

}  // namespace daft::audio::tests
