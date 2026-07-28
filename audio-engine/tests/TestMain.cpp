#include <exception>
#include <iostream>

namespace daft::audio::tests {
void RunSchedulerTests();
void RunClipPlayerNodeTests();
void RunPluginNodeTests();
void RunJunoCoreTests();
void RunInstrumentNodeTests();
void RunNodeFactoryTests();
void RunRealtimeControlQueueTests();
void RunRealtimeControlPlaneTests();
void RunSceneGraphTests();
void RunRenderPlanTests();
void RunGraphTransactionHostTests();
}  // namespace daft::audio::tests

int main() {
  try {
    daft::audio::tests::RunSceneGraphTests();
    daft::audio::tests::RunRenderPlanTests();
    daft::audio::tests::RunGraphTransactionHostTests();
    daft::audio::tests::RunSchedulerTests();
    daft::audio::tests::RunClipPlayerNodeTests();
    daft::audio::tests::RunPluginNodeTests();
    daft::audio::tests::RunJunoCoreTests();
    daft::audio::tests::RunInstrumentNodeTests();
    daft::audio::tests::RunNodeFactoryTests();
    daft::audio::tests::RunRealtimeControlQueueTests();
    daft::audio::tests::RunRealtimeControlPlaneTests();
  } catch (const std::exception& ex) {
    std::cerr << "Test failure: " << ex.what() << std::endl;
    return 1;
  }
  return 0;
}
