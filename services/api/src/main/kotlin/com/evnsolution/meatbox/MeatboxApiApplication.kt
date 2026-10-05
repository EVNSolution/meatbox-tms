package com.evnsolution.meatbox

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication

@SpringBootApplication
class MeatboxApiApplication

fun main(args: Array<String>) {
    runApplication<MeatboxApiApplication>(*args)
}
