package com.evnsolution.meatbox.auth

internal object NodeScryptFixture {
    const val ASCII_HASH =
        "scrypt\$16384\$8\$1\$literal-salt_01\$" +
            "yWKt5d_jhANOgsbAASd_UMY2CTII4PPsy5lwC_53Uc7koyunD_wi9TpdeaQvL8fPHI_W9MoEzk4fgBi9tgnYDg"
    const val UNICODE_HASH =
        "scrypt\$16384\$8\$1\$한글-salt\$" +
            "cfNATZOWdD6F5HH5V3yh9mnxlCmi3xjXEutwUL0SohgX1Fcu_AIGvZmDVC6bqMzn3q-EEky4XMw6sPEDSSIPUQ"

    fun accountJson(invites: String = "{}"): String =
        """{"version":1,"users":{"tester":{"username":"tester","displayName":"검토자",""" +
            """"passwordHash":"$ASCII_HASH","createdAt":1,"disabled":false}},"invites":$invites}"""
}
