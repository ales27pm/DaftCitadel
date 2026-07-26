// ============================================================

#pragma once

#include <cstddef>
#include <cstdint>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace Juno106 {

constexpr std::size_t SYSEX_MESSAGE_SIZE = 25;
constexpr std::uint8_t SYSEX_START = 0xF0;
constexpr std::uint8_t SYSEX_END = 0xF7;
constexpr std::uint8_t ROLAND_ID = 0x41;

struct JunoPatch {
    std::uint8_t lfoRate = 0;
    std::uint8_t lfoDelay = 0;
    std::uint8_t dcoLfoMod = 0;
    std::uint8_t dcoPwmDepth = 0;
    std::uint8_t dcoNoiseLevel = 0;
    std::uint8_t vcfCutoff = 0;
    std::uint8_t vcfResonance = 0;
    std::uint8_t vcfEnvMod = 0;
    std::uint8_t vcfLfoMod = 0;
    std::uint8_t vcfKeyFollow = 0;
    std::uint8_t vcaLevel = 0;
    std::uint8_t envAttack = 0;
    std::uint8_t envDecay = 0;
    std::uint8_t envSustain = 0;
    std::uint8_t envRelease = 0;
    std::uint8_t dcoSubLevel = 0;

    struct Switches {
        bool dcoFoot16 = false;
        bool dcoFoot8 = false;
        bool dcoFoot4 = false;
        bool pulseWaveOn = false;
        bool sawWaveOn = false;
        bool chorusOn = false;
        bool chorusLevelII = false;
        bool pwmSourceLFO = true;
        bool vcfEnvPositive = true;
        bool vcaModeEnv = true;
        std::uint8_t hpfSetting = 0;
    } switches;

    std::uint8_t sourcePatchNumber = 0;
    std::uint8_t midiChannel = 0;
    bool checksumValid = false;
};

class PatchParser {
public:
    static std::vector<JunoPatch> parseFile(const std::string& filepath) {
        std::ifstream file(filepath, std::ios::binary | std::ios::ate);
        if (!file.is_open()) {
            throw std::runtime_error("Cannot open file: " + filepath);
        }

        const std::streamsize fileSize = file.tellg();
        if (fileSize <= 0) {
            throw std::runtime_error("Empty file: " + filepath);
        }
        file.seekg(0, std::ios::beg);

        if (fileSize % static_cast<std::streamsize>(SYSEX_MESSAGE_SIZE) != 0) {
            throw std::runtime_error("Invalid Juno .106 file size");
        }

        const std::size_t numPatches = static_cast<std::size_t>(fileSize) / SYSEX_MESSAGE_SIZE;
        std::vector<std::uint8_t> buffer(numPatches * SYSEX_MESSAGE_SIZE);
        if (!file.read(reinterpret_cast<char*>(buffer.data()), fileSize)) {
            throw std::runtime_error("Failed to read Juno .106 file");
        }

        return parseBuffer(buffer, numPatches);
    }

    static std::vector<JunoPatch> parseBuffer(const std::vector<std::uint8_t>& buffer,
                                            std::size_t expectedPatches) {
        if (buffer.size() % SYSEX_MESSAGE_SIZE != 0) {
            throw std::runtime_error("Buffer size is not a multiple of SYSEX_MESSAGE_SIZE");
        }

        const std::size_t numPatches = buffer.size() / SYSEX_MESSAGE_SIZE;
        if (expectedPatches != 0 && numPatches != expectedPatches) {
            // Keep tolerant for file variants but enforce strict parsing in caller when needed.
        }

        std::vector<JunoPatch> patches;
        patches.reserve(numPatches);
        for (std::size_t i = 0; i < numPatches; ++i) {
            const std::size_t offset = i * SYSEX_MESSAGE_SIZE;
            std::vector<std::uint8_t> msg(
                buffer.begin() + static_cast<std::ptrdiff_t>(offset),
                buffer.begin() + static_cast<std::ptrdiff_t>(offset + SYSEX_MESSAGE_SIZE));
            patches.push_back(parseSingleSysex(msg, i));
        }
        return patches;
    }

    static JunoPatch parseSingleSysex(const std::vector<std::uint8_t>& msg, std::size_t patchIndex = 0) {
        if (msg.size() != SYSEX_MESSAGE_SIZE) {
            throw std::runtime_error("Unexpected sysex length for Juno-106 patch");
        }
        if (msg[0] != SYSEX_START || msg.back() != SYSEX_END) {
            throw std::runtime_error("Invalid sysex start/end bytes for Juno-106");
        }
        if (msg[1] != ROLAND_ID) {
            throw std::runtime_error("Not a Roland sysex message");
        }

        const std::uint8_t deviceChannel = msg[2] & 0x0F;
        const std::uint8_t patchNumber = msg[3] & 0x7F;
        const bool checksumOk = verifyChecksum(msg);

        JunoPatch patch;
        patch.midiChannel = deviceChannel;
        patch.sourcePatchNumber = patchNumber;
        patch.checksumValid = checksumOk;

        const std::size_t offsets[] = {
            5, 6, 7, 8,
            9, 10, 11, 12,
            13, 14, 15, 16,
            17, 18, 19, 20,
            21
        };
        std::uint8_t* params[] = {
            &patch.lfoRate,
            &patch.lfoDelay,
            &patch.dcoLfoMod,
            &patch.dcoPwmDepth,
            &patch.dcoNoiseLevel,
            &patch.vcfCutoff,
            &patch.vcfResonance,
            &patch.vcfEnvMod,
            &patch.vcfLfoMod,
            &patch.vcfKeyFollow,
            &patch.vcaLevel,
            &patch.envAttack,
            &patch.envDecay,
            &patch.envSustain,
            &patch.envRelease,
            &patch.dcoSubLevel
        };

        for (std::size_t i = 0; i < 16; ++i) {
            *params[i] = msg[offsets[i]];
        }
        decodeSwitches(msg[21], msg[22], patch.switches);

        (void)patchIndex;
        return patch;
    }

private:
    static bool verifyChecksum(const std::vector<std::uint8_t>& msg) {
        std::uint32_t sum = 0;
        for (std::size_t i = 5; i <= 22; ++i) {
            sum += msg[i] & 0x7F;
        }
        const std::uint8_t computed = static_cast<std::uint8_t>((128 - (sum & 0x7F)) & 0x7F);
        const std::uint8_t stored = msg[23] & 0x7F;
        return computed == stored;
    }

    static void decodeSwitches(std::uint8_t sw1, std::uint8_t sw2, JunoPatch::Switches& out) {
        out.dcoFoot16 = (sw1 & 0x01) != 0;
        out.dcoFoot8 = (sw1 & 0x02) != 0;
        out.dcoFoot4 = (sw1 & 0x04) != 0;
        out.pulseWaveOn = (sw1 & 0x08) != 0;
        out.sawWaveOn = (sw1 & 0x10) != 0;
        out.chorusOn = (sw1 & 0x20) == 0;
        out.chorusLevelII = (sw1 & 0x40) == 0;

        out.pwmSourceLFO = (sw2 & 0x01) == 0;
        out.vcfEnvPositive = (sw2 & 0x02) == 0;
        out.vcaModeEnv = (sw2 & 0x04) == 0;
        out.hpfSetting = static_cast<std::uint8_t>((sw2 >> 3) & 0x03);
    }
};

}  // namespace Juno106

// ============================================================
