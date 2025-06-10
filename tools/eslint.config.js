// SPDX-FileCopyrightText: 2025 Florian Müllner <fmuellner@gnome.org>
// SPDX-License-Identifier: MIT OR LGPL-2.0-or-later

import {defineConfig} from '@eslint/config-helpers';
import gnome from 'eslint-config-gnome';

export default defineConfig([
    gnome.configs.recommended,
    gnome.configs.jsdoc,
    {
        rules: {
            camelcase: ['error', {
                properties: 'never',
            }],
            'prefer-arrow-callback': 'error',
            'jsdoc/require-jsdoc': ['error', {
                publicOnly: true,
            }],
        },
        languageOptions: {
            globals: {
                debug: 'readonly',
                info: 'readonly',
                warning: 'readonly',
                critical: 'readonly',
                error: 'readonly',
                pkg: 'readonly',
                _: 'readonly',
                C_: 'readonly',
                N_: 'readonly',
                ngettext: 'readonly',
                vprintf: 'readonly',
            },
        },
    },
]);
