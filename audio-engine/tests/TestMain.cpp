#include <exception>
#include <iostream>

namespace daft::audio::tests {
void RunSchedulerTests();
void RunClipPlayerNodeTests();
void RunPluginNodeTests();
void RunSceneGraphTests();
void RunJunoCoreTests();
void RunInstrumentNodeTests();
}  // namespace daft::audio::tests

int main() {
  try {
    daft::audio::tests::RunSchedulerTests();
    daft::audio::tests::RunClipPlayerNodeTests();
    daft::audio::tests::RunPluginNodeTests();
    daft::audio::tests::RunSceneGraphTests();
    daft::audio::tests::RunJunoCoreTests();
    daft::audio::tests::RunInstrumentNodeTests();
  } catch (const std::exception& ex) {
    std::cerr << "Test failure: " << ex.what() << std::endl;
    return 1;
  }
  return 0;
}
