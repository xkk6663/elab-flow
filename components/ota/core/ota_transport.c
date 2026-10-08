#include "ota_transport.h"
#include <stddef.h>

const Transport *g_Transport = NULL;

void Transport_Attach(const Transport *t)
{
    g_Transport = t;
}

void Transport_Detach(void)
{
    g_Transport = NULL;
}

const Transport *Transport_GetCurrent(void)
{
    return g_Transport;
}

void Transport_Init(void)
{
    if (g_Transport && g_Transport->init) {
        g_Transport->init();
    }
}

void Transport_Deinit(void)
{
    if (g_Transport && g_Transport->deinit) {
        g_Transport->deinit();
    }
    Transport_Detach();
}
