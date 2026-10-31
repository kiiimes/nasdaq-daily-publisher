"""Pinned Codex tool registration policy; never use a remote model catalog."""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parent
VERSION = '0.166.0'
MODEL = 'gpt-6.1-sol'
DISABLED = ('shell_tool','unified_exec','code_mode','code_mode_host','code_mode_only',
 'computer_use','browser_use','browser_use_external','in_app_browser','plugins',
 'image_generation','view_image','multi_agent_v2','apps','multi_agent','hooks',
 'remote_plugin','goals','tool_suggest','skill_search','workspace_dependencies','shell_snapshot',
 'request_permissions_tool','token_budget','sleep_tool','deferred_executor',
 'send_message_to_user_async','agent_message_board','standalone_web_search')

def arguments():
    catalog = ROOT / 'editorial-models.json'
    data = json.loads(catalog.read_text())
    if len(data['models']) != 1: raise ValueError('Unexpected model catalog')
    m = data['models'][0]
    if not (m['slug']==MODEL and m['shell_type']=='disabled' and m['apply_patch_tool_type'] is None
            and m['experimental_supported_tools']==[] and m['tool_mode']=='direct'
            and m['supports_search_tool'] is False and m['use_responses_lite'] is False):
        raise ValueError('Editorial tool policy rejected')
    args=['--model',MODEL,'-c','model_catalog_json='+json.dumps(str(catalog)),
          '-c','tools.experimental_request_user_input.enabled=false',
          '-c','tools.update_plan.enabled=false']
    for feature in DISABLED: args += ['-c',f'features.{feature}=false']
    return args


def transport_schema(schema):
    """Provider subset only; the original stricter schema still validates output."""
    if isinstance(schema, list): return [transport_schema(x) for x in schema]
    if not isinstance(schema, dict): return schema
    return {('anyOf' if k == 'oneOf' else k): transport_schema(v)
            for k, v in schema.items() if k not in ('$schema', 'uniqueItems')}
