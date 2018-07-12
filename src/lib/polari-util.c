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

#include <string.h>

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

#ifdef HAVE_STRCASESTR
#  define FOLDFUNC(text) ((char *)(text))
#  define MATCHFUNC(haystick,needle) strcasestr (haystick, needle)
#else
#  define FOLDFUNC(text) g_utf8_casefold (text, -1)
#  define MATCHFUNC(haystick,needle) strstr (haystick, needle)
#endif

gboolean
polari_util_match_nick (const char *text,
                        const char *nick)
{
  g_autofree char *folded_text = NULL;
  g_autofree char *folded_nick = NULL;
  char *match;
  gboolean result = FALSE;
  int len;

  len = strlen (nick);
  if (len == 0)
    return FALSE;

  folded_text = FOLDFUNC (text);
  folded_nick = FOLDFUNC (nick);

  match = MATCHFUNC (folded_text, folded_nick);

  while (match != NULL)
    {
      gboolean starts_word, ends_word;

      /* assume ASCII nicknames, so no complex pango-style breaks */
      starts_word = (match == folded_text || !g_ascii_isalnum (*(match - 1)));
      ends_word = !g_ascii_isalnum (*(match + len));

      result = starts_word && ends_word;
      if (result)
        break;
      match = MATCHFUNC (match + len, folded_nick);
    }

  return result;
}

/**
 * polari_util_match_identify_message:
 * @message: a text message
 * @command: (optional) (out): the parsed command if the @message is an
 *                             identify command
 * @username: (optional) (out): the parsed name if the @message is an
 *                              identify command
 * @password: (optional) (out): the parsed password if the @message is an
 *                              identify command
 *
 * Returns: %TRUE if @message is an identify command
 */
gboolean
polari_util_match_identify_message (const char  *message,
                                    char       **command,
                                    char       **username,
                                    char       **password)
{
  static GRegex *identify_message_regex = NULL;
  g_autoptr(GMatchInfo) match = NULL;
  g_autofree char *text = NULL;
  char *stripped_text;
  gboolean matched;

  text = g_strdup (message);
  stripped_text = g_strstrip (text);

  if (G_UNLIKELY (identify_message_regex == NULL))
    identify_message_regex = g_regex_new ("^(identify|login) (?:(\\S+) )?(\\S+)$",
                                          G_REGEX_OPTIMIZE | G_REGEX_CASELESS,
                                          0, NULL);

  matched = g_regex_match (identify_message_regex, stripped_text, 0, &match);
  if (matched)
    {
      if (command)
        *command = g_match_info_fetch (match, 1);
      if (username)
        *username = g_match_info_fetch (match, 2);
      if (password)
        *password = g_match_info_fetch (match, 3);
    }

  return matched;
}
