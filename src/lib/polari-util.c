/* -*- Mode: C; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/*
 * Copyright (C) 2015 Red Hat, Inc.
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as published
 * by the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.";
 */

#include "polari-util.h"

#include <glib.h>

/**
 * polari_util_get_basenick:
 * @nick: (transfer none): the original nick
 *
 * Returns: (transfer full): the "base nick" of @nick, which can be used to
 *   group nicks that likely belong to the same person (e.g. "nick-away" or
 *   "nick|bbl")
 */
char *
polari_util_get_basenick (const char *nick)
{
  int len;

  for (len = 0; g_ascii_isalnum(nick[len]); len++)
    ;

  if (len > 0)
    return g_utf8_casefold (nick, len);
  else
    return g_utf8_casefold (nick, -1);
}
