package com.evnsolution.meatbox.legacy

import com.ibm.icu.text.Collator
import com.ibm.icu.text.RuleBasedCollator
import com.ibm.icu.util.ULocale
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import tools.jackson.core.JsonParser
import tools.jackson.core.JsonToken
import tools.jackson.core.JacksonException
import java.nio.file.Path
import java.security.MessageDigest
import java.util.HexFormat
import java.util.Locale

@Suppress("ComplexCondition", "ReturnCount", "TooManyFunctions")
class DestinationCatalogReader(
    settings: LegacySettings,
) {
    private val source = DispatchDataReader(settings)
    private val mapper = JsonMapper.builder().build()
    private val nameComparator = koreanCollator(Collator.PRIMARY, numeric = true)
    private val regionComparator = koreanCollator(Collator.TERTIARY, numeric = false)
    private val cacheLock = Any()
    private var snapshotCache: SnapshotCache? = null

    fun destinations(query: DestinationQuery, acceptEncoding: String?): DispatchFile {
        val manifest = source.loadManifest()
        val date = query.date ?: manifest.defaultDate
        if (date !in manifest.dates) throw queryInvalid()
        val search = query.q ?: ""
        if (search.length > MAX_QUERY_LENGTH) throw queryInvalid()
        val page = positiveInteger(query.page, DEFAULT_PAGE, MAX_PAGE)
        val pageSize = positiveInteger(query.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
        val snapshot = snapshot(manifest, date)
        val normalizedSearch = search.trim().lowercase(Locale.KOREA)
        val matches = if (normalizedSearch.isEmpty()) {
            snapshot.items
        } else {
            snapshot.items.filter { normalizedSearch in it.searchText }
        }
        val pageCount = maxOf(1, (matches.size + pageSize - 1) / pageSize)
        val currentPage = minOf(page, pageCount)
        val start = (currentPage - 1) * pageSize
        val dates = manifest.dates.filter { it <= date }.sorted()
        val body = DestinationResponse(
            date = date,
            fromDate = dates.first(),
            total = matches.size,
            page = currentPage,
            pageSize = pageSize,
            pageCount = pageCount,
            summary = snapshot.summary,
            items = matches.drop(start).take(pageSize).map(DestinationItem::publicValue),
        )
        return source.generatedJson(mapper.writeValueAsBytes(body), acceptEncoding)
    }

    private fun snapshot(manifest: Manifest, date: String): DestinationSnapshot {
        val path = Path.of("destinations.json")
        val signature = manifestSignature(manifest)
        val stamp = source.files.stampRequired(path)
        return synchronized(cacheLock) {
            val current = snapshotCache
            if (current != null && current.matches(stamp, signature, date)) {
                return@synchronized current.snapshot
            }
            val built = scanCatalog(path, manifest, signature, date)
            snapshotCache = SnapshotCache(stamp, signature, date, built)
            built
        }
    }

    private fun scanCatalog(
        path: Path,
        manifest: Manifest,
        signature: String,
        date: String,
    ): DestinationSnapshot = try {
        source.files.useRequired(path, missingManifest = false) { input ->
            mapper.createParser(input).use { parser -> parseCatalog(parser, manifest, signature, date) }
        }
    } catch (error: DispatchDataException) {
        throw error
    } catch (error: JacksonException) {
        throw invalidCatalog(error)
    }

    private fun parseCatalog(
        parser: JsonParser,
        manifest: Manifest,
        signature: String,
        date: String,
    ): DestinationSnapshot {
        requireToken(parser.nextToken(), JsonToken.START_OBJECT)
        var schemaVersion: JsonNode? = null
        var catalogSource: JsonNode? = null
        var snapshot: DestinationSnapshot? = null
        while (parser.nextToken() != JsonToken.END_OBJECT) {
            requireToken(parser.currentToken(), JsonToken.PROPERTY_NAME)
            val name = parser.currentName()
            val valueToken = parser.nextToken()
            when (name) {
                "schemaVersion" -> schemaVersion = parser.readValueAsTree()
                "source" -> catalogSource = parser.readValueAsTree()
                "destinations" -> snapshot = parseDestinations(parser, valueToken, manifest.dates, date)
                else -> parser.skipChildren()
            }
        }
        if (parser.nextToken() != null) throw invalidCatalog()
        val manifestSource = manifest.node.get("source")
        val sourceValid = sameJavascriptPrimitive(catalogSource?.get("csvSha256"), manifestSource?.get("csvSha256")) &&
            catalogSource?.get("manifestSignature")?.takeIf(JsonNode::isString)?.asString() == signature &&
            sameJson(catalogSource.get("dateShift"), manifestSource?.get("dateShift"))
        if (schemaVersion?.takeIf(JsonNode::isInt)?.asInt() != 1 || !sourceValid || snapshot == null) {
            throw invalidCatalog()
        }
        return snapshot
    }

    private fun parseDestinations(
        parser: JsonParser,
        token: JsonToken,
        dates: Set<String>,
        targetDate: String,
    ): DestinationSnapshot {
        requireToken(token, JsonToken.START_ARRAY)
        val ids = mutableSetOf<String>()
        val items = mutableListOf<DestinationItem>()
        var orders = 0.0
        var boxes = 0.0
        while (parser.nextToken() != JsonToken.END_ARRAY) {
            val item = parseDestination(parser, dates, targetDate, ids)
            if (item != null) {
                items.add(item)
                orders += item.orderCount.toDouble()
                boxes += item.boxCount.toDouble()
            }
        }
        items.sortWith { left, right ->
            nameComparator.compare(left.sortName, right.sortName).takeIf { it != 0 }
                ?: left.id.compareTo(right.id)
        }
        return DestinationSnapshot(
            items,
            DestinationSummary(
                items.size,
                javascriptNumber(orders),
                javascriptNumber(boxes),
            ),
        )
    }

    @Suppress("CyclomaticComplexMethod", "ReturnCount")
    private fun parseDestination(
        parser: JsonParser,
        dates: Set<String>,
        targetDate: String,
        ids: MutableSet<String>,
    ): DestinationItem? {
        requireToken(parser.currentToken(), JsonToken.START_OBJECT)
        var id: String? = null
        var name: String? = null
        var address: String? = null
        var detailAddress: String? = null
        var days: DestinationDays? = null
        while (parser.nextToken() != JsonToken.END_OBJECT) {
            requireToken(parser.currentToken(), JsonToken.PROPERTY_NAME)
            val field = parser.currentName()
            val token = parser.nextToken()
            when (field) {
                "id" -> id = readString(parser, token)
                "name" -> name = readString(parser, token)
                "address" -> address = readString(parser, token)
                "detailAddress" -> detailAddress = readString(parser, token)
                "dates" -> days = parseDays(parser, token, dates, targetDate)
                else -> parser.skipChildren()
            }
        }
        if (id.isNullOrEmpty() || name == null || address == null || detailAddress == null || days == null) {
            throw invalidCatalog()
        }
        if (!ids.add(id)) throw invalidCatalog()
        if (days.orderDays == 0) return null
        val publicName = if (LETTER_OR_NUMBER.containsMatchIn(name)) name else address
        return DestinationItem(
            id = id,
            name = publicName,
            address = address,
            detailAddress = detailAddress,
            regionNames = days.regionNames.sortedWith(regionComparator),
            orderCount = javascriptNumber(days.orderCount),
            boxCount = javascriptNumber(days.boxCount),
            orderDays = days.orderDays,
            firstOrderDate = days.firstOrderDate.orEmpty(),
            lastOrderDate = days.lastOrderDate.orEmpty(),
            sortName = publicName.replace(LEADING_NON_ALPHANUMERIC, "").ifEmpty { publicName },
            searchText = listOf(publicName, address, detailAddress, *days.regionNames.toTypedArray())
                .joinToString(" ").lowercase(Locale.KOREA),
        )
    }

    @Suppress("CyclomaticComplexMethod")
    private fun parseDays(
        parser: JsonParser,
        token: JsonToken,
        dates: Set<String>,
        targetDate: String,
    ): DestinationDays {
        requireToken(token, JsonToken.START_ARRAY)
        var previous = ""
        var totalDays = 0
        var includedDays = 0
        var orders = 0.0
        var boxes = 0.0
        var first: String? = null
        var last: String? = null
        val regions = linkedSetOf<String>()
        while (parser.nextToken() != JsonToken.END_ARRAY) {
            val day = parseDay(parser)
            if (day.date !in dates || day.date <= previous) throw invalidCatalog()
            previous = day.date
            totalDays += 1
            if (day.date <= targetDate) {
                includedDays += 1
                orders += day.orderCount
                boxes += day.boxCount
                if (first == null) first = day.date
                last = day.date
                regions.addAll(day.regionNames)
            }
        }
        if (totalDays == 0) throw invalidCatalog()
        return DestinationDays(includedDays, orders, boxes, first, last, regions)
    }

    @Suppress("CyclomaticComplexMethod")
    private fun parseDay(parser: JsonParser): DestinationDay {
        requireToken(parser.currentToken(), JsonToken.START_OBJECT)
        var date: String? = null
        var regionNames: List<String>? = null
        var orderCount: Double? = null
        var boxCount: Double? = null
        while (parser.nextToken() != JsonToken.END_OBJECT) {
            requireToken(parser.currentToken(), JsonToken.PROPERTY_NAME)
            val field = parser.currentName()
            val token = parser.nextToken()
            when (field) {
                "date" -> date = readString(parser, token)
                "regionNames" -> regionNames = readStrings(parser, token)
                "orderCount" -> orderCount = readNumber(parser, token, integer = true)
                "boxCount" -> boxCount = readNumber(parser, token, integer = false)
                else -> parser.skipChildren()
            }
        }
        if (date == null || regionNames == null || orderCount == null || boxCount == null) throw invalidCatalog()
        return DestinationDay(date, regionNames, orderCount, boxCount)
    }

    private fun readStrings(parser: JsonParser, token: JsonToken): List<String> {
        requireToken(token, JsonToken.START_ARRAY)
        val values = mutableListOf<String>()
        while (parser.nextToken() != JsonToken.END_ARRAY) values.add(readString(parser, parser.currentToken()))
        return values
    }

    private fun readString(parser: JsonParser, token: JsonToken): String {
        requireToken(token, JsonToken.VALUE_STRING)
        return parser.string
    }

    private fun readNumber(parser: JsonParser, token: JsonToken, integer: Boolean): Double {
        if (!token.isNumeric) throw invalidCatalog()
        val value = parser.doubleValue
        if (!value.isFinite() || value < 0 || integer && value % 1.0 != 0.0) throw invalidCatalog()
        return value
    }

    private fun requireToken(actual: JsonToken?, expected: JsonToken) {
        if (actual != expected) throw invalidCatalog()
    }

    private fun manifestSignature(manifest: Manifest): String {
        val sourceNode = manifest.node.get("source")
        val shift = sourceNode?.get("dateShift")
        val tuple = mapper.createArrayNode()
        tuple.add(sourceNode?.get("csvSha256"))
        if (shift != null && !shift.isNull) {
            val shiftTuple = mapper.createArrayNode()
            shiftTuple.add(shift.get("sourceDate"))
            shiftTuple.add(shift.get("operatingDate"))
            shiftTuple.add(shift.get("offsetDays"))
            tuple.add(shiftTuple)
        } else {
            tuple.addNull()
        }
        val sortedDates = mapper.createArrayNode()
        manifest.dates.sorted().forEach(sortedDates::add)
        tuple.add(sortedDates)
        val bytes = mapper.writeValueAsBytes(tuple)
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes))
    }

    private fun sameJson(left: JsonNode?, right: JsonNode?): Boolean {
        val leftValue = left?.takeUnless(JsonNode::isNull)
        val rightValue = right?.takeUnless(JsonNode::isNull)
        return mapper.writeValueAsString(leftValue) == mapper.writeValueAsString(rightValue)
    }

    private fun sameJavascriptPrimitive(left: JsonNode?, right: JsonNode?): Boolean {
        if (left == null || left.isNull) return right == null || right.isNull
        val hasMissingRight = right == null || right.isNull
        val hasContainer = left.isObject || left.isArray || right?.isObject == true || right?.isArray == true
        if (hasMissingRight || hasContainer) return false
        return if (left.isNumber && right.isNumber) left.asDouble() == right.asDouble() else left == right
    }

    private fun positiveInteger(value: String?, fallback: Int, maximum: Int): Int {
        if (value == null) return fallback
        if (!POSITIVE_INTEGER.matches(value)) throw queryInvalid()
        val parsed = value.toLongOrNull()?.takeIf { it <= maximum } ?: throw queryInvalid()
        return parsed.toInt()
    }

    private fun javascriptNumber(value: Double): Number = if (
        value.isFinite() && value % 1.0 == 0.0 && value >= Long.MIN_VALUE && value <= Long.MAX_VALUE
    ) {
        value.toLong()
    } else {
        value
    }

    companion object {
        private const val DEFAULT_PAGE = 1
        private const val DEFAULT_PAGE_SIZE = 20
        private const val MAX_PAGE = 1_000_000
        private const val MAX_PAGE_SIZE = 100
        private const val MAX_QUERY_LENGTH = 100
        private val POSITIVE_INTEGER = Regex("^[1-9]\\d*$")
        private val LETTER_OR_NUMBER = Regex("[\\p{L}\\p{N}]")
        private val LEADING_NON_ALPHANUMERIC = Regex("^[^\\p{L}\\p{N}]+")
    }
}

data class DestinationQuery(
    val date: String?,
    val q: String?,
    val page: String?,
    val pageSize: String?,
)

private data class DestinationSnapshot(val items: List<DestinationItem>, val summary: DestinationSummary)

private data class SnapshotCache(
    val stamp: FileStamp,
    val manifestSignature: String,
    val date: String,
    val snapshot: DestinationSnapshot,
) {
    fun matches(otherStamp: FileStamp, otherSignature: String, otherDate: String): Boolean =
        stamp == otherStamp && manifestSignature == otherSignature && date == otherDate
}

private data class DestinationDays(
    val orderDays: Int,
    val orderCount: Double,
    val boxCount: Double,
    val firstOrderDate: String?,
    val lastOrderDate: String?,
    val regionNames: Set<String>,
)

private data class DestinationDay(
    val date: String,
    val regionNames: List<String>,
    val orderCount: Double,
    val boxCount: Double,
)

private data class DestinationSummary(val destinations: Int, val orders: Number, val boxes: Number)

private data class PublicDestinationItem(
    val id: String,
    val name: String,
    val address: String,
    val detailAddress: String,
    val regionNames: List<String>,
    val orderCount: Number,
    val boxCount: Number,
    val orderDays: Int,
    val firstOrderDate: String,
    val lastOrderDate: String,
)

private data class DestinationItem(
    val id: String,
    val name: String,
    val address: String,
    val detailAddress: String,
    val regionNames: List<String>,
    val orderCount: Number,
    val boxCount: Number,
    val orderDays: Int,
    val firstOrderDate: String,
    val lastOrderDate: String,
    val sortName: String,
    val searchText: String,
) {
    fun publicValue() = PublicDestinationItem(
        id,
        name,
        address,
        detailAddress,
        regionNames,
        orderCount,
        boxCount,
        orderDays,
        firstOrderDate,
        lastOrderDate,
    )
}

private data class DestinationResponse(
    val date: String,
    val fromDate: String,
    val total: Int,
    val page: Int,
    val pageSize: Int,
    val pageCount: Int,
    val summary: DestinationSummary,
    val items: List<PublicDestinationItem>,
)

private fun koreanCollator(strength: Int, numeric: Boolean): RuleBasedCollator {
    val collator = Collator.getInstance(ULocale.KOREAN) as RuleBasedCollator
    collator.strength = strength
    collator.setNumericCollation(numeric)
    return collator
}

private fun invalidCatalog(cause: Throwable? = null) =
    DispatchDataException(org.springframework.http.HttpStatus.INTERNAL_SERVER_ERROR, "DISPATCH_DATA_INVALID", cause)
