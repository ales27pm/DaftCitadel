package com.daftcitadel.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.os.Process
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max

/** Owns Android device I/O while AudioEngineBridge remains device-agnostic. */
internal class AudioTrackDeviceDriver(
  private val renderInterleaved: (FloatArray, Int, Int) -> Unit
) {
  private val running = AtomicBoolean(false)

  @Volatile
  private var audioTrack: AudioTrack? = null

  @Volatile
  private var renderThread: Thread? = null

  @Synchronized
  fun start(sampleRate: Int, framesPerBuffer: Int) {
    stop()
    require(sampleRate > 0) { "sampleRate must be positive" }
    require(framesPerBuffer > 0) { "framesPerBuffer must be positive" }

    val channelCount = OUTPUT_CHANNEL_COUNT
    val channelMask = AudioFormat.CHANNEL_OUT_STEREO
    val bytesPerFrame = channelCount * Float.SIZE_BYTES
    val minimumBytes = AudioTrack.getMinBufferSize(
      sampleRate,
      channelMask,
      AudioFormat.ENCODING_PCM_FLOAT
    )
    require(minimumBytes > 0) { "AudioTrack does not support the requested output format" }
    val deviceBufferBytes = max(minimumBytes, framesPerBuffer * bytesPerFrame * 2)

    val format = AudioFormat.Builder()
      .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
      .setSampleRate(sampleRate)
      .setChannelMask(channelMask)
      .build()
    val attributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_MEDIA)
      .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
      .build()
    val builder = AudioTrack.Builder()
      .setAudioAttributes(attributes)
      .setAudioFormat(format)
      .setTransferMode(AudioTrack.MODE_STREAM)
      .setBufferSizeInBytes(deviceBufferBytes)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      builder.setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
    }

    val track = builder.build()
    check(track.state == AudioTrack.STATE_INITIALIZED) { "AudioTrack failed to initialize" }

    val renderBuffer = FloatArray(framesPerBuffer * channelCount)
    running.set(true)
    audioTrack = track
    val thread = Thread({ renderLoop(track, renderBuffer, framesPerBuffer) }, THREAD_NAME)
    renderThread = thread
    try {
      track.play()
      thread.start()
    } catch (error: Throwable) {
      running.set(false)
      renderThread = null
      audioTrack = null
      track.release()
      throw error
    }
  }

  @Synchronized
  fun isRunning(): Boolean =
    running.get() &&
      audioTrack?.playState == AudioTrack.PLAYSTATE_PLAYING &&
      renderThread?.isAlive == true

  @Synchronized
  fun stop() {
    running.set(false)
    val track = audioTrack
    audioTrack = null
    if (track != null) {
      runCatching { track.pause() }
      runCatching { track.flush() }
      runCatching { track.stop() }
    }

    val thread = renderThread
    renderThread = null
    if (thread != null && thread !== Thread.currentThread()) {
      thread.interrupt()
      runCatching { thread.join(STOP_TIMEOUT_MS) }
      if (thread.isAlive) {
        Log.w(TAG, "Audio render thread did not stop within ${STOP_TIMEOUT_MS}ms")
      }
    }
    track?.release()
  }

  private fun renderLoop(
    track: AudioTrack,
    renderBuffer: FloatArray,
    framesPerBuffer: Int
  ) {
    Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
    try {
      while (running.get()) {
        renderInterleaved(renderBuffer, OUTPUT_CHANNEL_COUNT, framesPerBuffer)
        var offset = 0
        while (running.get() && offset < renderBuffer.size) {
          val written = track.write(
            renderBuffer,
            offset,
            renderBuffer.size - offset,
            AudioTrack.WRITE_BLOCKING
          )
          if (written <= 0) {
            if (running.get()) {
              Log.e(TAG, "AudioTrack write failed with status $written")
            }
            running.set(false)
            break
          }
          offset += written
        }
      }
    } catch (error: Throwable) {
      if (running.get()) {
        Log.e(TAG, "Audio render thread failed", error)
      }
      running.set(false)
    }
  }

  private companion object {
    const val TAG = "DaftAudioDevice"
    const val THREAD_NAME = "DaftCitadelAudioRender"
    const val OUTPUT_CHANNEL_COUNT = 2
    const val STOP_TIMEOUT_MS = 2_000L
  }
}
