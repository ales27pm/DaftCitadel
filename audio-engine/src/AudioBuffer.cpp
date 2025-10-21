#include "audio_engine/AudioBuffer.h"

namespace daft::audio {
// Explicit instantiations for commonly used buffer sizes.
template class StackAudioBuffer<2, 1024>;
template class StackAudioBuffer<4, 1024>;
}  // namespace daft::audio
