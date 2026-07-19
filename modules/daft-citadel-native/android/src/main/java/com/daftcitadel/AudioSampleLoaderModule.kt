package com.daftcitadel

import android.net.Uri
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors

@ReactModule(name = AudioSampleLoaderModule.NAME)
class AudioSampleLoaderModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  private val decoder = Executors.newSingleThreadExecutor { task ->
    Thread(task, "DaftCitadelAudioDecoder").apply { isDaemon = true }
  }

  override fun getName(): String = NAME

  @ReactMethod
  fun decode(filePath: String, promise: Promise) {
    val normalizedPath = filePath.trim()
    if (normalizedPath.isEmpty()) {
      promise.reject("invalid_path", "Audio file path is required")
      return
    }

    decoder.execute {
      try {
        val bytes = openAudioSource(normalizedPath).use(::readBounded)
        promise.resolve(decodeWave(bytes))
      } catch (error: Exception) {
        promise.reject("decode_failed", "Unable to decode '$normalizedPath'", error)
      }
    }
  }

  override fun invalidate() {
    decoder.shutdownNow()
    super.invalidate()
  }

  private fun openAudioSource(filePath: String): InputStream {
    val uri = Uri.parse(filePath)
    if (uri.scheme == "content") {
      return reactContext.contentResolver.openInputStream(uri)
        ?: throw IllegalArgumentException("Unable to open content URI")
    }
    val path = if (uri.scheme == "file") uri.path ?: filePath else filePath
    val requested = File(path)
    val resolved = if (requested.isAbsolute) requested else File(reactContext.filesDir, path)
    return resolved.inputStream()
  }

  private fun readBounded(stream: InputStream): ByteArray {
    val output = ByteArrayOutputStream()
    val chunk = ByteArray(64 * 1024)
    var total = 0
    while (true) {
      val count = stream.read(chunk)
      if (count < 0) break
      total += count
      require(total <= MAX_FILE_BYTES) { "Audio file exceeds ${MAX_FILE_BYTES / 1_048_576} MB" }
      output.write(chunk, 0, count)
    }
    return output.toByteArray()
  }

  private fun decodeWave(bytes: ByteArray) = Arguments.createMap().apply {
    require(bytes.size >= 44) { "WAVE file is truncated" }
    require(ascii(bytes, 0, 4) == "RIFF" && ascii(bytes, 8, 4) == "WAVE") {
      "Only RIFF/WAVE audio is supported on Android"
    }

    var formatOffset = -1
    var formatSize = 0
    var dataOffset = -1
    var dataSize = 0
    var offset = 12
    while (offset + 8 <= bytes.size) {
      val chunkId = ascii(bytes, offset, 4)
      val chunkSize = unsignedInt(bytes, offset + 4)
      require(chunkSize <= Int.MAX_VALUE.toLong()) { "WAVE chunk is too large" }
      val payloadSize = chunkSize.toInt()
      val payloadOffset = offset + 8
      require(payloadOffset + payloadSize <= bytes.size) { "WAVE chunk is truncated" }
      when (chunkId) {
        "fmt " -> {
          formatOffset = payloadOffset
          formatSize = payloadSize
        }
        "data" -> {
          dataOffset = payloadOffset
          dataSize = payloadSize
        }
      }
      offset = payloadOffset + payloadSize + (payloadSize and 1)
    }

    require(formatOffset >= 0 && formatSize >= 16) { "WAVE format chunk is missing" }
    require(dataOffset >= 0 && dataSize > 0) { "WAVE data chunk is missing" }

    var formatTag = unsignedShort(bytes, formatOffset)
    val channelCount = unsignedShort(bytes, formatOffset + 2)
    val sampleRate = unsignedInt(bytes, formatOffset + 4)
    val blockAlign = unsignedShort(bytes, formatOffset + 12)
    val bitsPerSample = unsignedShort(bytes, formatOffset + 14)
    if (formatTag == 0xfffe && formatSize >= 40) {
      formatTag = unsignedShort(bytes, formatOffset + 24)
    }

    require(formatTag == 1 || formatTag == 3) { "Unsupported WAVE encoding $formatTag" }
    require(channelCount in 1..64) { "WAVE channel count must be between 1 and 64" }
    require(sampleRate in 1..384_000) { "WAVE sample rate is invalid" }
    require(bitsPerSample in setOf(8, 16, 24, 32)) { "Unsupported WAVE bit depth $bitsPerSample" }
    require(formatTag != 3 || bitsPerSample == 32) { "IEEE-float WAVE must use 32-bit samples" }

    val bytesPerSample = bitsPerSample / 8
    require(blockAlign == channelCount * bytesPerSample) { "Unsupported packed WAVE layout" }
    val frameCount = dataSize / blockAlign
    require(frameCount in 1..MAX_FRAMES) { "WAVE frame count is outside engine limits" }

    val channels = Array(channelCount) {
      ByteBuffer.allocate(frameCount * Float.SIZE_BYTES).order(ByteOrder.LITTLE_ENDIAN)
    }
    for (frame in 0 until frameCount) {
      val frameOffset = dataOffset + frame * blockAlign
      for (channel in 0 until channelCount) {
        val sampleOffset = frameOffset + channel * bytesPerSample
        channels[channel].putFloat(readSample(bytes, sampleOffset, formatTag, bitsPerSample))
      }
    }

    val channelPayloads = Arguments.createArray()
    channels.forEach { channel ->
      channelPayloads.pushString(Base64.encodeToString(channel.array(), Base64.NO_WRAP))
    }
    putDouble("sampleRate", sampleRate.toDouble())
    putInt("channels", channelCount)
    putInt("frames", frameCount)
    putArray("channelData", channelPayloads)
  }

  private fun readSample(
    bytes: ByteArray,
    offset: Int,
    formatTag: Int,
    bitsPerSample: Int
  ): Float {
    if (formatTag == 3) {
      return ByteBuffer.wrap(bytes, offset, 4).order(ByteOrder.LITTLE_ENDIAN).float
        .coerceIn(-1f, 1f)
    }
    return when (bitsPerSample) {
      8 -> ((bytes[offset].toInt() and 0xff) - 128) / 128f
      16 -> littleEndianShort(bytes, offset) / 32768f
      24 -> {
        var value = (bytes[offset].toInt() and 0xff) or
          ((bytes[offset + 1].toInt() and 0xff) shl 8) or
          ((bytes[offset + 2].toInt() and 0xff) shl 16)
        if ((value and 0x800000) != 0) value = value or -0x1000000
        value / 8_388_608f
      }
      32 -> littleEndianInt(bytes, offset) / 2_147_483_648f
      else -> error("Unsupported WAVE sample format")
    }
  }

  private fun ascii(bytes: ByteArray, offset: Int, count: Int): String =
    bytes.copyOfRange(offset, offset + count).toString(Charsets.US_ASCII)

  private fun unsignedShort(bytes: ByteArray, offset: Int): Int =
    littleEndianShort(bytes, offset).toInt() and 0xffff

  private fun unsignedInt(bytes: ByteArray, offset: Int): Long =
    littleEndianInt(bytes, offset).toLong() and 0xffff_ffffL

  private fun littleEndianShort(bytes: ByteArray, offset: Int): Short =
    ByteBuffer.wrap(bytes, offset, 2).order(ByteOrder.LITTLE_ENDIAN).short

  private fun littleEndianInt(bytes: ByteArray, offset: Int): Int =
    ByteBuffer.wrap(bytes, offset, 4).order(ByteOrder.LITTLE_ENDIAN).int

  companion object {
    const val NAME = "AudioSampleLoaderModule"
    private const val MAX_FILE_BYTES = 512 * 1024 * 1024
    private const val MAX_FRAMES = 10_000_000
  }
}
