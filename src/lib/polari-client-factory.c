/*
 * SPDX-FileCopyrightText: 2017 Florian Müllner <fmuellner@gnome.org>
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

#include "polari-client-factory.h"

G_DEFINE_TYPE (PolariClientFactory, polari_client_factory, TP_TYPE_AUTOMATIC_CLIENT_FACTORY)

PolariClientFactory *
polari_client_factory_new (void)
{
  return g_object_new (POLARI_TYPE_CLIENT_FACTORY, NULL);
}

/**
 * polari_client_factory_create_account:
 * Returns: (transfer full):
 */
TpAccount *
polari_client_factory_create_account (PolariClientFactory  *self,
                                      const char           *object_path,
                                      GError              **error)
{
  PolariClientFactoryClass *klass = POLARI_CLIENT_FACTORY_GET_CLASS (self);
  TpSimpleClientFactoryClass *simple_class =
    TP_SIMPLE_CLIENT_FACTORY_CLASS (polari_client_factory_parent_class);

  if (klass->create_account)
    return klass->create_account (self, object_path, error);

  return simple_class->create_account (TP_SIMPLE_CLIENT_FACTORY (self),
                                       object_path,
                                       NULL,
                                       error);
}

static TpAccount *
polari_client_factory_create_account_impl (TpSimpleClientFactory  *self,
                                           const char             *object_path,
                                           const GHashTable       *immutable_props G_GNUC_UNUSED,
                                           GError                **error)
{
  return polari_client_factory_create_account (POLARI_CLIENT_FACTORY (self),
                                               object_path,
                                               error);
}

static void
polari_client_factory_class_init (PolariClientFactoryClass *klass)
{
  TpSimpleClientFactoryClass *simple_class = TP_SIMPLE_CLIENT_FACTORY_CLASS (klass);

  simple_class->create_account = polari_client_factory_create_account_impl;
}

static void
polari_client_factory_init (PolariClientFactory *self G_GNUC_UNUSED)
{
}
