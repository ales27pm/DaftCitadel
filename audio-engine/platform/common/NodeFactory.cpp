#include "NodeFactory.h"

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <limits>

namespace daft::audio::bridge::detail {
namespace {

std::optional<double> parseNumericString(const std::string& value) noexcept {
  if (value.empty()) {
    return std::nullopt;
  }

  errno = 0;
  char* end = nullptr;
  const char* const begin = value.c_str();
  const double parsed = std::strtod(begin, &end);
  if (end == begin || end != begin + value.size() || errno == ERANGE ||
      !std::isfinite(parsed)) {
    return std::nullopt;
  }
  return parsed;
}

}  // namespace

void storeStringOption(NodeOptions& options, const std::string& key,
                       const std::string& value) {
  options.setString(key, value);
  const auto normalized = normalize(value);
  if (normalized == "true" || normalized == "yes" || normalized == "on") {
    options.setNumeric(key, 1.0);
  } else if (normalized == "false" || normalized == "no" ||
             normalized == "off") {
    options.setNumeric(key, 0.0);
  } else if (const auto parsed = parseNumericString(value)) {
    options.setNumeric(key, *parsed);
  }
}

bool parseBoolean(const NodeOptions& options, const std::string& key, bool defaultValue) {
  if (const auto numeric = options.numericValue(key)) {
    return std::fabs(*numeric) > std::numeric_limits<double>::epsilon();
  }
  if (auto stringValue = options.stringValue(key)) {
    auto normalized = normalize(*stringValue);
    if (normalized == "true" || normalized == "yes" || normalized == "on") {
      return true;
    }
    if (normalized == "false" || normalized == "no" || normalized == "off") {
      return false;
    }
  }
  return defaultValue;
}

std::optional<std::string> stringFromOptions(const NodeOptions& options, const std::string& key) {
  if (auto str = options.stringValue(key)) {
    if (!str->empty()) {
      return str;
    }
  }
  if (auto numeric = options.numericValue(key)) {
    if (auto converted = toIntegerString(*numeric)) {
      if (!converted->empty()) {
        return converted;
      }
    }
  }
  return std::nullopt;
}

}  // namespace daft::audio::bridge::detail
