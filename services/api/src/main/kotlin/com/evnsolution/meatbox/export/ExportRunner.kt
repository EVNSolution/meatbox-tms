package com.evnsolution.meatbox.export

import org.springframework.boot.ApplicationArguments
import org.springframework.boot.ApplicationRunner
import java.io.PrintStream
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest

/**
 * `--meatbox.export.out=/abs/archive.zip [--meatbox.export.from= --meatbox.export.to= --meatbox.export.include=a,b]`
 * with `--spring.main.web-application-type=none` writes the same archive as the API, from the host, with the
 * server stopped or running. Prints the path, the size and the SHA-256 of the archive.
 */
class ExportRunner(
    private val writer: ExportWriter,
    private val out: String,
    private val from: String,
    private val to: String,
    private val include: String,
    private val webApplicationType: String,
) : ApplicationRunner {
    override fun run(args: ApplicationArguments) {
        if (out.isEmpty()) return
        execute(System.out)
    }

    internal fun execute(output: PrintStream) {
        require(webApplicationType.equals("none", ignoreCase = true)) {
            "The export command requires --spring.main.web-application-type=none"
        }
        val target = Path.of(out)
        require(target.isAbsolute && target.normalize() == target) {
            "meatbox.export.out must be a normalized absolute path"
        }
        require(target.parent != null && Files.isDirectory(target.parent)) {
            "meatbox.export.out parent directory must exist"
        }
        val groups = include.split(',').map(String::trim).filter(String::isNotEmpty).ifEmpty { null }
        val request = ExportRequest.of(from, to, groups)
        writer.write(request, target)
        val digest = MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(target))
        output.println("$target ${Files.size(target)} ${digest.joinToString("") { "%02x".format(it) }}")
    }
}
