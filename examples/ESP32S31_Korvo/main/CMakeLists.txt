idf_component_register(SRCS "heartbeat_main.c"
                       INCLUDE_DIRS "."
                       PRIV_REQUIRES esp_driver_rmt esp_timer esp_wifi esp_netif nvs_flash)
