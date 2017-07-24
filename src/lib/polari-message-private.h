/*
 * SPDX-FileCopyrightText: 2017 Florian Müllner <fmuellner@gnome.org>
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

#pragma once

#include "polari-message.h"

G_BEGIN_DECLS

struct _PolariMessage
{
  GDateTime *time;
  char *sender;
  char *text;
  gboolean is_action;
  gboolean is_self;
};

PolariMessage *polari_message_new_empty (void);

G_END_DECLS
