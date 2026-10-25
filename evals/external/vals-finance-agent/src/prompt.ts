// Agent instruction prompt. Mirrors finance_agent/prompt.py (INSTRUCTIONS_PROMPT,
// rendered with Python's str.format, so "{{"/"}}" become "{"/"}") character for
// character, with ONE substitution: the data-storage paragraph, which describes
// tools this harness does not have (parse_html_page / retrieve_information), is
// replaced by an equivalent paragraph about web_fetch. Like the official harness,
// the whole prompt is sent as the first user message; no system prompt is used.

/** The official paragraph, kept for the record (tools.py has these tools; we do not). */
export const OFFICIAL_DATA_STORAGE_PARAGRAPH =
  "You will have access to a data storage system. You can use this system to store parsed contents of HTML pages retrieved from the web. \n" +
  "You can then use the retrieve_information tool to apply answer questions or gather information from the stored documents using LLM-based prompts.\n" +
  "This data storage system is designed to help you avoid context window issues. \n";

/** Our replacement: same role (context-safe document access), our tool. */
export const HARNESS_FETCH_PARAGRAPH =
  "You will have access to a web_fetch tool. You can use it to retrieve the contents of HTML pages and documents found on the web or through edgar_search. \n" +
  "It can run code to filter a large document before its contents reach your context, so you can extract only the information you need.\n" +
  "This is designed to help you avoid context window issues. \n";

const OFFICIAL_PROMPT_TEMPLATE =
  "\nYou are a financial agent. You are given a question and you need to answer it using the tools provided.\n" +
  "You will not be able to interact with the user or ask clarifications, you must answer the question only based on the information provided.\n" +
  "\n" +
  "You should answer all questions as if the current date is April 07, 2025.\n" +
  "\n" +
  OFFICIAL_DATA_STORAGE_PARAGRAPH +
  "\n" +
  "When you have the final answer, you should call the `submit_final_result` tool with it. Your submission will not be processed unless you call this tool. \n" +
  "\n" +
  "You should include any necessary step-by-step reasoning, justification, calculations, or explanation in your answer. You will be evaluated both on the accuracy of the final answer, and the correctness of the supporting logic.\n" +
  "\n" +
  "When possible, please provide any calculated answers to at least two decimal places (e.g. 18.78% rather than 19%). Please do not round intermediate steps in any calculations - you should only round your final answer.\n" +
  "\n" +
  "At the end of your answer, you should provide your sources in a dictionary with the following format:\n" +
  "{\n" +
  '    "sources": [\n' +
  "        {\n" +
  '            "url": "https://example.com",\n' +
  '            "name": "Name of the source"\n' +
  "        },\n" +
  "        ...\n" +
  "    ]\n" +
  "}\n" +
  "\n" +
  "Question:\n" +
  "{question}\n";

export const PROMPT_TEMPLATE = OFFICIAL_PROMPT_TEMPLATE.replace(
  OFFICIAL_DATA_STORAGE_PARAGRAPH,
  HARNESS_FETCH_PARAGRAPH,
);

export function officialPrompt(question: string): string {
  return OFFICIAL_PROMPT_TEMPLATE.replace("{question}", () => question);
}

export function agentPrompt(question: string): string {
  return PROMPT_TEMPLATE.replace("{question}", () => question);
}
