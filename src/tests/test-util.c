/* test-util.c
 *
 * Copyright 2018 Florian Müllner <fmuellner@gnome.org>
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
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

#include <locale.h>

#include "polari-util.h"

static void
test_base_nick_basic (void)
{
  g_autofree char *res = NULL;

  res = polari_util_get_basenick ("nick");
  g_assert_cmpstr (res, ==, "nick");
}

static void
test_base_nick_trailing (void)
{
  g_autofree char *res = NULL;

  res = polari_util_get_basenick ("nick_");
  g_assert_cmpstr (res, ==, "nick");
}

static void
test_base_nick_numeric (void)
{
  g_autofree char *res = NULL;

  res = polari_util_get_basenick ("nick42");
  g_assert_cmpstr (res, ==, "nick42");
}

static void
test_match_nick_nomatch (void)
{
  gboolean res;

  res = polari_util_match_nick ("Hello, world!", "nick");
  g_assert_false (res);
}

static void
test_match_nick_match (void)
{
  gboolean res;

  res = polari_util_match_nick ("Hello, nick!", "nick");
  g_assert_true (res);
}

static void
test_match_nick_match2 (void)
{
  gboolean res;

  res = polari_util_match_nick ("nick: Hello!", "nick");
  g_assert_true (res);
}

static void
test_match_nick_trailing_junk (void)
{
  gboolean res;

  res = polari_util_match_nick ("Hello nicky!", "nick");
  g_assert_false (res);
}

static void
test_match_nick_leading_junk (void)
{
  gboolean res;

  res = polari_util_match_nick ("knick!", "nick");
  g_assert_false (res);
}

static void
test_match_nick_numeric (void)
{
  gboolean res;

  res = polari_util_match_nick ("nick42: Hi", "nick");
  g_assert_false (res);
}

static void
test_match_nick_numeric2 (void)
{
  gboolean res;

  res = polari_util_match_nick ("nick42: Hi", "nick42");
  g_assert_true (res);
}

static void
test_match_nick_mixed_case (void)
{
  gboolean res;

  res = polari_util_match_nick ("Hello Nick", "nick");
  g_assert_true (res);
}

static void
test_match_nick_mixed_case2 (void)
{
  gboolean res;

  res = polari_util_match_nick ("Hello nick", "Nick");
  g_assert_true (res);
}

static void
test_match_nick_away (void)
{
  gboolean res;

  res = polari_util_match_nick ("nick-away: Hi", "nick");
  g_assert_true (res);
}

static void
test_match_identify_nomatch (void)
{
  gboolean res;
  g_autofree char *command = NULL;
  g_autofree char *user = NULL;
  g_autofree char *password = NULL;

  res = polari_util_match_identify_message ("regular message",
                                            &command, &user, &password);
  g_assert_false (res);
  g_assert_null (command);
  g_assert_null (user);
  g_assert_null (password);
}

static void
test_match_identify_match (void)
{
  gboolean res;
  g_autofree char *command = NULL;
  g_autofree char *user = NULL;
  g_autofree char *password = NULL;

  res = polari_util_match_identify_message ("identify nick pass",
                                            &command, &user, &password);
  g_assert_true (res);
  g_assert_cmpstr (command, ==, "identify");
  g_assert_cmpstr (user, ==, "nick");
  g_assert_cmpstr (password, ==, "pass");
}

static void
test_match_identify_no_user (void)
{
  gboolean res;
  g_autofree char *command = NULL;
  g_autofree char *user = NULL;
  g_autofree char *password = NULL;

  res = polari_util_match_identify_message ("identify pass",
                                            &command, &user, &password);
  g_assert_true (res);
  g_assert_cmpstr (command, ==, "identify");
  g_assert_cmpstr (user, ==, "");
  g_assert_cmpstr (password, ==, "pass");
}

static void
test_match_identify_login (void)
{
  gboolean res;
  g_autofree char *command = NULL;
  g_autofree char *user = NULL;
  g_autofree char *password = NULL;

  res = polari_util_match_identify_message ("login nick pass",
                                            &command, &user, &password);
  g_assert_true (res);
  g_assert_cmpstr (command, ==, "login");
  g_assert_cmpstr (user, ==, "nick");
  g_assert_cmpstr (password, ==, "pass");
}

static void
test_match_identify_case (void)
{
  gboolean res;
  g_autofree char *command = NULL;
  g_autofree char *user = NULL;
  g_autofree char *password = NULL;

  res = polari_util_match_identify_message ("IDENTify nick pass",
                                            &command, &user, &password);
  g_assert_true (res);
  g_assert_cmpstr (command, ==, "IDENTify");
  g_assert_cmpstr (user, ==, "nick");
  g_assert_cmpstr (password, ==, "pass");
}

int
main (int argc, char *argv[])
{
  setlocale (LC_ALL, "");

  g_test_init (&argc, &argv, NULL);

  g_test_add_func ("/util/base-nick/basic", test_base_nick_basic);
  g_test_add_func ("/util/base-nick/trailing", test_base_nick_trailing);
  g_test_add_func ("/util/base-nick/numeric", test_base_nick_numeric);

  g_test_add_func ("/util/match-nick/nomatch", test_match_nick_nomatch);
  g_test_add_func ("/util/match-nick/match", test_match_nick_match);
  g_test_add_func ("/util/match-nick/match2", test_match_nick_match2);
  g_test_add_func ("/util/match-nick/trailing-junk", test_match_nick_trailing_junk);
  g_test_add_func ("/util/match-nick/leading-junk", test_match_nick_leading_junk);
  g_test_add_func ("/util/match-nick/numeric", test_match_nick_numeric);
  g_test_add_func ("/util/match-nick/numeric2", test_match_nick_numeric2);
  g_test_add_func ("/util/match-nick/mixed-case", test_match_nick_mixed_case);
  g_test_add_func ("/util/match-nick/mixed-case2", test_match_nick_mixed_case2);
  g_test_add_func ("/util/match-nick/away", test_match_nick_away);

  g_test_add_func ("/util/match-identify/nomatch", test_match_identify_nomatch);
  g_test_add_func ("/util/match-identify/match", test_match_identify_match);
  g_test_add_func ("/util/match-identify/no-user", test_match_identify_no_user);
  g_test_add_func ("/util/match-identify/login", test_match_identify_login);
  g_test_add_func ("/util/match-identify/case", test_match_identify_case);

  return g_test_run ();
}
