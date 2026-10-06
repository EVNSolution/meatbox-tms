package com.evnsolution.meatbox.auth

import jakarta.servlet.http.HttpServletRequest
import org.springframework.http.MediaType
import java.io.ByteArrayOutputStream
import java.net.URLDecoder
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.LinkedHashMap

internal class FormParser {
    fun parse(request: HttpServletRequest): Map<String, String> {
        val mediaType = request.contentType?.substringBefore(';')?.trim()
        if (!mediaType.equals(MediaType.APPLICATION_FORM_URLENCODED_VALUE, ignoreCase = true)) invalid()
        if (request.contentLengthLong > MAX_FORM_BYTES) invalid()
        val raw = decodeUtf8(readLimited(request))
        val values = LinkedHashMap<String, String>()
        if (raw.isEmpty()) return values
        for (part in raw.split('&')) {
            val index = part.indexOf('=')
            val rawName = if (index < 0) part else part.substring(0, index)
            val rawValue = if (index < 0) "" else part.substring(index + 1)
            val name = decodeForm(rawName)
            if (name.isEmpty() || values.putIfAbsent(name, decodeForm(rawValue)) != null) invalid()
        }
        return values
    }

    private fun readLimited(request: HttpServletRequest): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
            val count = request.inputStream.read(buffer)
            if (count < 0) break
            if (output.size() + count > MAX_FORM_BYTES) invalid()
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }

    private fun decodeUtf8(bytes: ByteArray): String = runCatching {
        StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes)).toString()
    }.getOrElse { invalid() }

    private fun decodeForm(value: String): String = runCatching {
        URLDecoder.decode(value, StandardCharsets.UTF_8)
    }.getOrElse { invalid() }

    private fun invalid(): Nothing = throw IllegalArgumentException("Invalid form")

    companion object {
        private const val MAX_FORM_BYTES = 4 * 1024
    }
}
