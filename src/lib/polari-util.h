/* -*- Mode: C; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/*
 * SPDX-FileCopyrightText: 2015 Red Hat, Inc
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

#pragma once

#include <glib.h>

char *polari_util_get_basenick (const char *nick);

gboolean polari_util_match_nick (const char *text,
		                 const char *nick);

gboolean polari_util_match_identify_message (const char  *message,
                                             char       **command,
                                             char       **username,
                                             char       **password);
