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
delete_option('baseline_scan_defaults');

delete_post_meta_by_key('_baseline_scan_options');
delete_post_meta_by_key('_baseline_scan_use_site_defaults');
delete_post_meta_by_key('_baseline_last_scan_id');
