package com.evnsolution.meatbox.auth

/** What an account may do. `ops` runs the business screens, `driver` only the driver app of its own vehicles. */
enum class Role(val wire: String) {
    OPS("ops"),
    DRIVER("driver"),
    ;

    companion object {
        fun parse(value: String?): Role? = entries.firstOrNull { it.wire == value }
    }
}

/** The signed-in user. A null [role] is an account whose stored role is not one of ours: it may use nothing. */
data class SessionIdentity(val username: String, val role: Role?)
