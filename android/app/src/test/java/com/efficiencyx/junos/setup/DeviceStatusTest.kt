package com.efficiencyx.junos.setup

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceStatusTest {
    @Test
    fun acceptsEightGigabyteClassDeviceWithReservedMemory() {
        val status = DeviceStatus(
            supportedAbi = true,
            totalRamBytes = (7.2 * 1024 * 1024 * 1024).toLong(),
            freeStorageBytes = 6L * 1024 * 1024 * 1024,
        )

        assertTrue(status.hasRequiredRam)
        assertTrue(status.supported)
    }

    @Test
    fun warnsButAllowsDeviceBelowReportedRamThreshold() {
        val status = DeviceStatus(
            supportedAbi = true,
            totalRamBytes = DeviceStatus.MIN_REPORTED_RAM - 1,
            freeStorageBytes = 6L * 1024 * 1024 * 1024,
        )

        assertFalse(status.hasRequiredRam)
        assertTrue(status.supported)
    }
}
