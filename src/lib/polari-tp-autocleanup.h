/*
 * SPDX-FileCopyrightText: 2017 Florian Müllner <fmuellner@gnome.org>
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

#pragma once

#include <glib-object.h>

G_BEGIN_DECLS

G_DEFINE_AUTOPTR_CLEANUP_FUNC (TpAutomaticClientFactory, g_object_unref)
G_DEFINE_AUTOPTR_CLEANUP_FUNC (TpMessage, g_object_unref)
G_DEFINE_AUTOPTR_CLEANUP_FUNC (TpContactInfoField, tp_contact_info_field_free)

G_END_DECLS
