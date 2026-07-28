#include <exception>
#include <iostream>

namespace daft::audio::tests {
void RunSchedulerTests();
void RunClipPlayerNodeTests();
void RunPluginNodeTests();
void RunJunoCoreTests();
void RunInstrumentNodeTests();
void RunRealtimeControlQueueTests();
void RunRealtimeControlPlaneTests();
void RunSceneGraphTests();
}  // namespace daft::audio::tests

void RunRenderPlanTests();
void RunGraphTransactionHostTests();

int main() {
  daft::audio::tests::RunSceneGraphTests();
  RunRenderPlanTests();
  RunGraphTransactionHostTests();
  try {
    daft::audio::tests::RunSchedulerTests();
    daft::audio::tests::RunClipPlayerNodeTests();
    daft::audio::tests::RunPluginNodeTests();
    daft::audio::tests::RunJunoCoreTests();
    daft::audio::tests::RunInstrumentNodeTests();
    daft::audio::tests::RunRealtimeControlQueueTests();
    daft::audio::tests::RunRealtimeControlPlaneTests();
  } catch (const std::exception& ex) {
    std::cerr << "Test failure: " << ex.what() << std::endl;
    return 1;
  }
  return 0;
}
