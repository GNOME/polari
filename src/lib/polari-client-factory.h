/* polari-client-factory.h
 *
 * Copyright © 2017 Florian Müllner <fmuellner@gnome.org>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
#pragma once

#include <telepathy-glib/telepathy-glib.h>
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
