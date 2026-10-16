package com.evnsolution.meatbox.integrations.meatbox.inbound

import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

/** The token check exists only with a token, so a deployment without one has no `/api/meatbox` paths at all. */
@Configuration(proxyBeanMethods = false)
@ConditionalOnExpression("'\${meatbox.dispatch.enabled:false}' == 'true' && '\${meatbox.inbound.token:}' != ''")
class InboundEndpointConfiguration {
    @Bean
    fun meatboxInboundFilter(@Value("\${meatbox.inbound.token:}") token: String): MeatboxInboundFilter =
        MeatboxInboundFilter(token)
}
