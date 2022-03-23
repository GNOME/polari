/*
 * SPDX-FileCopyrightText: 2017 Florian Müllner <fmuellner@gnome.org>
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

#pragma once

#include <glib-object.h>

G_GNUC_BEGIN_IGNORE_DEPRECATIONS
#include <telepathy-glib/telepathy-glib.h>
G_GNUC_END_IGNORE_DEPRECATIONS
#include "polari-tp-autocleanup.h"

G_BEGIN_DECLS

#define POLARI_TYPE_CLIENT_FACTORY (polari_client_factory_get_type())

G_DECLARE_DERIVABLE_TYPE (PolariClientFactory, polari_client_factory, POLARI, CLIENT_FACTORY, TpAutomaticClientFactory)

struct _PolariClientFactoryClass
{
  TpAutomaticClientFactoryClass parent;

  TpAccount * (*create_account) (PolariClientFactory  *self,
                                 const char           *object_path,
                                 GError              **error);
};

PolariClientFactory *polari_client_factory_new (void);
TpAccount *polari_client_factory_create_account (PolariClientFactory  *self,
                                                 const char           *object_path,
                                                 GError              **error);

G_END_DECLS
