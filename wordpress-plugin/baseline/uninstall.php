<?php

if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

delete_option('baseline_api_base_url');
delete_option('baseline_site_token');
delete_option('baseline_site_id');
delete_option('baseline_tenant_id');
delete_option('baseline_last_scan_id');
delete_option('baseline_default_form_mode');
