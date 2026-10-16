package com.evnsolution.meatbox.eta

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import tools.jackson.databind.json.JsonMapper

class PointInPolygonTest {
    private fun geometry(json: String) = JsonMapper.builder().build().readTree(json)

    private val square = "[[0,0],[10,0],[10,10],[0,10],[0,0]]"
    private val hole = "[[4,4],[6,4],[6,6],[4,6],[4,4]]"

    @Test
    fun `a polygon holds the points inside its ring only`() {
        val polygon = geometry("""{"type":"Polygon","coordinates":[$square]}""")
        assertThat(insideGeometry(polygon, EtaPoint(lat = 5.0, lng = 5.0))).isTrue()
        assertThat(insideGeometry(polygon, EtaPoint(lat = 5.0, lng = 11.0))).isFalse()
        assertThat(insideGeometry(polygon, EtaPoint(lat = -1.0, lng = 5.0))).isFalse()
    }

    @Test
    fun `a hole is outside and the ring around it is inside`() {
        val polygon = geometry("""{"type":"Polygon","coordinates":[$square,$hole]}""")
        assertThat(insideGeometry(polygon, EtaPoint(lat = 5.0, lng = 5.0))).isFalse()
        assertThat(insideGeometry(polygon, EtaPoint(lat = 2.0, lng = 5.0))).isTrue()
    }

    @Test
    fun `a multipolygon holds a point that lies in any of its polygons`() {
        val far = "[[20,20],[30,20],[30,30],[20,30],[20,20]]"
        val multi = geometry("""{"type":"MultiPolygon","coordinates":[[$square],[$far]]}""")
        assertThat(insideGeometry(multi, EtaPoint(lat = 25.0, lng = 25.0))).isTrue()
        assertThat(insideGeometry(multi, EtaPoint(lat = 5.0, lng = 5.0))).isTrue()
        assertThat(insideGeometry(multi, EtaPoint(lat = 15.0, lng = 15.0))).isFalse()
    }

    @Test
    fun `another geometry type or an empty polygon holds nothing`() {
        assertThat(insideGeometry(geometry("""{"type":"Point","coordinates":[5,5]}"""), EtaPoint(5.0, 5.0))).isFalse()
        assertThat(insideGeometry(geometry("""{"type":"Polygon","coordinates":[]}"""), EtaPoint(5.0, 5.0))).isFalse()
    }
}
