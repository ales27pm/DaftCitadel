#include <exception>
#include <iostream>

namespace daft::audio::tests {
void RunSchedulerTests();
void RunClipPlayerNodeTests();
}  // namespace daft::audio::tests

int main() {
  try {
    daft::audio::tests::RunSchedulerTests();
    daft::audio::tests::RunClipPlayerNodeTests();
  } catch (const std::exception& ex) {
    std::cerr << "Test failure: " << ex.what() << std::endl;
    return 1;
  }
  return 0;
}
