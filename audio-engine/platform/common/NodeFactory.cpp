#include "NodeFactory.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace daft::audio::bridge::detail {

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
